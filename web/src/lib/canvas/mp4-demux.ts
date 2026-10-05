import { getMediaBlob } from "@/services/file-storage";

// mp4 (ISO BMFF) box scanning: enough to find the sample table and the codec config,
// so a video frame can be decoded exactly instead of seeking the <video> element.

export type Mp4TrackInfo = {
    trackId: number;
    codec: string;
    codedWidth: number;
    codedHeight: number;
    description: Uint8Array;
    timescale: number;
    durationSec: number;
    samples: Mp4Sample[];
};

export type Mp4Sample = { offset: number; size: number; dts: number; cts: number; isSync: boolean };

export type Mp4Parsed = {
    tracks: Mp4TrackInfo[];
};

type Box = { type: string; start: number; end: number; contentStart: number };

const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex"]);

function* readBoxes(view: DataView, start: number, end: number): Generator<Box> {
    let cursor = start;
    while (cursor + 8 <= end) {
        let size = view.getUint32(cursor);
        const type = String.fromCharCode(view.getUint8(cursor + 4), view.getUint8(cursor + 5), view.getUint8(cursor + 6), view.getUint8(cursor + 7));
        let contentStart = cursor + 8;
        if (size === 1) {
            if (cursor + 16 > end) return;
            const high = view.getUint32(cursor + 8);
            const low = view.getUint32(cursor + 12);
            size = high * 2 ** 32 + low;
            contentStart = cursor + 16;
        } else if (size === 0) {
            size = end - cursor;
        }
        if (size < 8 || cursor + size > end) return;
        yield { type, start: cursor, end: cursor + size, contentStart };
        cursor += size;
    }
}

function findBox(view: DataView, start: number, end: number, path: string[]): Box | null {
    let scopeStart = start;
    let scopeEnd = end;
    let found: Box | null = null;
    for (const type of path) {
        found = null;
        for (const box of readBoxes(view, scopeStart, scopeEnd)) {
            if (box.type === type) {
                found = box;
                break;
            }
        }
        if (!found) return null;
        scopeStart = found.contentStart;
        scopeEnd = found.end;
    }
    return found;
}

function findChildren(view: DataView, parent: Box, type: string) {
    return Array.from(readBoxes(view, parent.contentStart, parent.end)).filter((box) => box.type === type);
}

function readFullBox(view: DataView, box: Box) {
    const version = view.getUint8(box.contentStart);
    const flags = (view.getUint8(box.contentStart + 1) << 16) | (view.getUint8(box.contentStart + 2) << 8) | view.getUint8(box.contentStart + 3);
    return { version, flags, body: box.contentStart + 4 };
}

function fourCC(view: DataView, offset: number) {
    return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

/** Parse the first video track of an ISO BMFF (mp4/mov) file. Returns null when the layout is unsupported. */
export function parseMp4(buffer: ArrayBuffer): Mp4Parsed | null {
    const view = new DataView(buffer);
    const moov = findBox(view, 0, view.byteLength, ["moov"]);
    if (!moov) return null;
    const tracks: Mp4TrackInfo[] = [];
    for (const trak of findChildren(view, moov, "trak")) {
        const track = parseTrak(view, buffer, trak);
        if (track) tracks.push(track);
    }
    return tracks.length ? { tracks } : null;
}

function parseTrak(view: DataView, buffer: ArrayBuffer, trak: Box): Mp4TrackInfo | null {
    const tkhd = findBox(view, trak.contentStart, trak.end, ["tkhd"]);
    if (!tkhd) return null;
    const tkhdBody = readFullBox(view, tkhd);
    const trackId = tkhdBody.version === 1 ? view.getUint32(tkhdBody.body + 16) : view.getUint32(tkhdBody.body + 8);

    const mdia = findBox(view, trak.contentStart, trak.end, ["mdia"]);
    if (!mdia) return null;
    const hdlr = findBox(view, mdia.contentStart, mdia.end, ["hdlr"]);
    if (!hdlr) return null;
    const handlerType = fourCC(view, readFullBox(view, hdlr).body + 4);
    if (handlerType !== "vide") return null;

    const mdhd = findBox(view, mdia.contentStart, mdia.end, ["mdhd"]);
    const minf = findBox(view, mdia.contentStart, mdia.end, ["minf"]);
    const stbl = minf ? findBox(view, minf.contentStart, minf.end, ["stbl"]) : null;
    if (!mdhd || !stbl) return null;

    const mdhdBody = readFullBox(view, mdhd);
    // mdhd payload: creation(4/8) modification(4/8) timescale(4) duration(4/8).
    const timescale = mdhdBody.version === 1 ? view.getUint32(mdhdBody.body + 16) : view.getUint32(mdhdBody.body + 8);
    const duration = mdhdBody.version === 1 ? Number(view.getBigUint64(mdhdBody.body + 20)) : view.getUint32(mdhdBody.body + 12);
    if (!timescale) return null;

    const stsd = findBox(view, stbl.contentStart, stbl.end, ["stsd"]);
    const stts = findBox(view, stbl.contentStart, stbl.end, ["stts"]);
    const stsc = findBox(view, stbl.contentStart, stbl.end, ["stsc"]);
    const stsz = findBox(view, stbl.contentStart, stbl.end, ["stsz"]);
    const stco = findBox(view, stbl.contentStart, stbl.end, ["stco"]) || findBox(view, stbl.contentStart, stbl.end, ["co64"]);
    const stss = findBox(view, stbl.contentStart, stbl.end, ["stss"]);
    const ctts = findBox(view, stbl.contentStart, stbl.end, ["ctts"]);
    if (!stsd || !stts || !stsc || !stsz || !stco) return null;

    const codec = parseStsd(view, buffer, stsd);
    if (!codec) return null;

    const sizes = parseStsz(view, stsz);
    const chunkOffsets = parseStco(view, stco);
    const stscEntries = parseStsc(view, stsc);
    const syncSamples = stss ? parseStss(view, stss) : null;
    const sampleDts = parseStts(view, stts, sizes.length);
    const compositionOffsets = ctts ? parseCtts(view, ctts, sizes.length) : null;

    const samples = buildSamples(sizes, chunkOffsets, stscEntries, sampleDts, compositionOffsets, syncSamples);
    if (!samples.length) return null;

    return {
        trackId,
        codec: codec.codec,
        codedWidth: codec.width,
        codedHeight: codec.height,
        description: codec.description,
        timescale,
        durationSec: duration / timescale,
        samples,
    };
}

function parseStsd(view: DataView, buffer: ArrayBuffer, stsd: Box) {
    const { body } = readFullBox(view, stsd);
    const entryCount = view.getUint32(body);
    if (!entryCount) return null;
    let cursor = body + 4;
    const entry = readBoxes(view, cursor, stsd.end).next();
    if (entry.done) return null;
    const sample = entry.value;
    // VisualSampleEntry: width/height live 24 bytes into the payload; child boxes follow the 78-byte header.
    const width = view.getUint16(sample.contentStart + 24);
    const height = view.getUint16(sample.contentStart + 26);
    const childStart = sample.contentStart + 78;
    const codecBox = Array.from(readBoxes(view, childStart, sample.end)).find((box) => box.type === "avcC" || box.type === "hvcC" || box.type === "av1C" || box.type === "vpcC");
    if (!codecBox) return null;
    const payload = new Uint8Array(buffer, codecBox.contentStart, codecBox.end - codecBox.contentStart);
    const description = copyBytes(payload);
    if (codecBox.type === "avcC") return { codec: avcCodecString(payload), width, height, description };
    if (codecBox.type === "hvcC") return { codec: hvcCodecString(payload), width, height, description };
    if (codecBox.type === "av1C") return { codec: "av01.0.04M.08", width, height, description };
    return null;
}

function copyBytes(source: Uint8Array) {
    const target = new Uint8Array(source.byteLength);
    target.set(source);
    return target;
}

function avcCodecString(avcC: Uint8Array) {
    const profile = avcC[1];
    const compat = avcC[2];
    const level = avcC[3];
    return `avc1.${profile.toString(16).padStart(2, "0")}${compat.toString(16).padStart(2, "0")}${level.toString(16).padStart(2, "0")}`;
}

function hvcCodecString(hvcC: Uint8Array) {
    const profileSpace = hvcC[1] >> 6;
    const tierFlag = (hvcC[1] >> 5) & 1;
    const profileIdc = hvcC[1] & 31;
    const compat = (hvcC[2] << 24) | (hvcC[3] << 16) | (hvcC[4] << 8) | hvcC[5];
    const level = hvcC[12];
    const space = " ACB".charAt(profileSpace);
    return `hvc1.${space}${profileIdc}.${(compat >>> 0).toString(16)}.${tierFlag ? "H" : "L"}${level}`;
}

function parseStsz(view: DataView, stsz: Box) {
    const { body } = readFullBox(view, stsz);
    const uniform = view.getUint32(body);
    const count = view.getUint32(body + 4);
    const sizes: number[] = [];
    if (uniform) {
        for (let index = 0; index < count; index += 1) sizes.push(uniform);
    } else {
        for (let index = 0; index < count; index += 1) sizes.push(view.getUint32(body + 8 + index * 4));
    }
    return sizes;
}

function parseStco(view: DataView, stco: Box) {
    const { version, body } = readFullBox(view, stco);
    const count = view.getUint32(body);
    const offsets: number[] = [];
    for (let index = 0; index < count; index += 1) {
        offsets.push(version === 1 ? Number(view.getBigUint64(body + 4 + index * 8)) : view.getUint32(body + 4 + index * 4));
    }
    return offsets;
}

function parseStsc(view: DataView, stsc: Box) {
    const { body } = readFullBox(view, stsc);
    const count = view.getUint32(body);
    const entries: { firstChunk: number; samplesPerChunk: number }[] = [];
    for (let index = 0; index < count; index += 1) {
        const offset = body + 4 + index * 12;
        entries.push({ firstChunk: view.getUint32(offset), samplesPerChunk: view.getUint32(offset + 4) });
    }
    return entries;
}

function parseStss(view: DataView, stss: Box) {
    const { body } = readFullBox(view, stss);
    const count = view.getUint32(body);
    const sync = new Set<number>();
    for (let index = 0; index < count; index += 1) sync.add(view.getUint32(body + 4 + index * 4) - 1);
    return sync;
}

function parseStts(view: DataView, stts: Box, total: number) {
    const { body } = readFullBox(view, stts);
    const count = view.getUint32(body);
    const dts: number[] = [];
    let time = 0;
    for (let entry = 0; entry < count && dts.length < total; entry += 1) {
        const offset = body + 4 + entry * 8;
        const sampleCount = view.getUint32(offset);
        const delta = view.getUint32(offset + 4);
        for (let index = 0; index < sampleCount && dts.length < total; index += 1) {
            dts.push(time);
            time += delta;
        }
    }
    while (dts.length < total) dts.push(dts.length ? dts[dts.length - 1] : 0);
    return dts;
}

function parseCtts(view: DataView, ctts: Box, total: number) {
    const { version, body } = readFullBox(view, ctts);
    const count = view.getUint32(body);
    const offsets: number[] = [];
    for (let entry = 0; entry < count && offsets.length < total; entry += 1) {
        const offset = body + 4 + entry * 8;
        const sampleCount = view.getUint32(offset);
        const value = version === 1 ? view.getInt32(offset + 4) : view.getUint32(offset + 4);
        for (let index = 0; index < sampleCount && offsets.length < total; index += 1) offsets.push(value);
    }
    while (offsets.length < total) offsets.push(0);
    return offsets;
}

function buildSamples(sizes: number[], chunkOffsets: number[], stsc: { firstChunk: number; samplesPerChunk: number }[], dts: number[], cts: number[] | null, sync: Set<number> | null): Mp4Sample[] {
    const samples: Mp4Sample[] = [];
    let sampleIndex = 0;
    for (let chunk = 0; chunk < chunkOffsets.length; chunk += 1) {
        let perChunk = stsc.length ? stsc[0].samplesPerChunk : 0;
        for (let entry = 0; entry < stsc.length; entry += 1) {
            if (chunk + 1 >= stsc[entry].firstChunk) perChunk = stsc[entry].samplesPerChunk;
        }
        let offset = chunkOffsets[chunk];
        for (let index = 0; index < perChunk && sampleIndex < sizes.length; index += 1) {
            samples.push({
                offset,
                size: sizes[sampleIndex],
                dts: dts[sampleIndex] || 0,
                cts: (dts[sampleIndex] || 0) + (cts ? cts[sampleIndex] || 0 : 0),
                isSync: sync ? sync.has(sampleIndex) : true,
            });
            offset += sizes[sampleIndex];
            sampleIndex += 1;
        }
    }
    return samples;
}

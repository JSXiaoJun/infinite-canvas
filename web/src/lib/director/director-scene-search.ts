import type { DirectorCamera, DirectorLight, DirectorObject, DirectorScene } from "@/types/director";

export type DirectorSceneSearchItem =
    | { kind: "camera"; id: string; name: string; camera: DirectorCamera }
    | { kind: "object"; id: string; name: string; object: DirectorObject }
    | { kind: "light"; id: string; name: string; light: DirectorLight };

/** Flat scene hierarchy shown by the director sidebar; filtering never changes the scene. */
export function searchDirectorSceneItems(scene: DirectorScene, query: string): DirectorSceneSearchItem[] {
    const items: DirectorSceneSearchItem[] = [
        ...scene.cameras.map((camera) => ({ kind: "camera" as const, id: camera.id, name: camera.name, camera })),
        ...scene.objects.map((object) => ({ kind: "object" as const, id: object.id, name: object.name, object })),
        ...scene.lights.map((light) => ({ kind: "light" as const, id: light.id, name: light.name, light })),
    ];
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? items.filter((item) => item.name.toLocaleLowerCase().includes(normalized)) : items;
}

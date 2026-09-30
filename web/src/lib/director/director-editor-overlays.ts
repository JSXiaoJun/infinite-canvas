import type { Color, Material, Mesh, Object3D } from "three";

type TintableMaterial = Material & { color?: Color };

/**
 * Editor aids are visible in the workbench, never in captured frames or video.
 * - Objects tagged `userData.directorEditorOnly` are hidden.
 * - Materials tagged `userData.directorBaseColor` (selection tint) render their unselected color.
 */
export function suspendDirectorEditorOverlays(scene: Object3D): () => void {
    const hidden: Array<{ object: Object3D; visible: boolean }> = [];
    const tinted: Array<{ target: Color; color: Color }> = [];
    const seen = new Set<Material>();
    scene.traverse((object) => {
        if (object.userData.directorEditorOnly === true) {
            hidden.push({ object, visible: object.visible });
            object.visible = false;
        }
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials as TintableMaterial[]) {
            const baseColor = material?.userData?.directorBaseColor;
            if (typeof baseColor !== "string" || !material.color || seen.has(material)) continue;
            seen.add(material);
            tinted.push({ target: material.color, color: material.color.clone() });
            material.color.set(baseColor);
        }
    });
    return () => {
        for (const item of hidden) item.object.visible = item.visible;
        for (const item of tinted) item.target.copy(item.color);
    };
}

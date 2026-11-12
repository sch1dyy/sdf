import * as THREE from 'three';

type Shader = Parameters<THREE.Material['onBeforeCompile']>[0];

/** Half the internal resolution: clip space spans two units, so this snaps to whole low-res pixels. */
export const snapUniform = { value: new THREE.Vector2(240, 135) };

/** PS1-style vertex snapping: the console had no sub-pixel precision, so geometry wobbles as it moves. */
export function applyVertexSnap(shader: Shader): void {
  shader.uniforms.uSnap = snapUniform;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform vec2 uSnap;')
    .replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      gl_Position.xy = floor(gl_Position.xy / gl_Position.w * uSnap + 0.5) / uSnap * gl_Position.w;`,
    );
}

export function psx<T extends THREE.Material>(material: T): T {
  material.onBeforeCompile = applyVertexSnap;
  return material;
}

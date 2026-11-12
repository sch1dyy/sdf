import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// A dark studio around the sword: a pink key overhead and a few tall strips of light at the
// horizon. The strips are what flash along the blade as it turns.
const FRAG = /* glsl */ `
varying vec3 vDir;

float card(vec3 d, float centre, float width) {
  float a = atan(d.z, d.x) - centre;
  a = abs(atan(sin(a), cos(a)));
  return smoothstep(width, width * 0.35, a) * smoothstep(-0.3, 0.0, d.y) * smoothstep(0.8, 0.4, d.y);
}

void main() {
  vec3 d = normalize(vDir);
  vec3 c = vec3(0.012, 0.004, 0.018);
  c += vec3(0.30, 0.06, 0.20) * exp(-pow(d.y / 0.2, 2.0));
  c += vec3(3.2, 0.8, 1.7) * smoothstep(0.8, 0.97, d.y);
  c += vec3(2.4, 1.8, 2.8) * card(d, 0.9, 0.17);
  c += vec3(2.6, 0.5, 1.0) * card(d, -2.2, 0.24);
  c += vec3(1.0, 0.4, 1.6) * card(d, 2.6, 0.32);
  c += vec3(1.8, 0.7, 0.3) * card(d, -0.6, 0.09);
  c += vec3(0.14, 0.05, 0.09) * smoothstep(0.0, -0.6, d.y);
  gl_FragColor = vec4(c, 1.0);
}`;

/** Prefiltered environment for the steel and fittings to reflect. */
export function createEnvMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), material));

  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  material.dispose();
  return texture;
}

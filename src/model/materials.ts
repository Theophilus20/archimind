import type { Material } from './types';

export const MATERIALS: Material[] = [
  { id: 'plaster', name: 'White plaster', color: '#f1eee8', roughness: 0.92, metalness: 0, use: 'wall' },
  { id: 'render', name: 'Lime render', color: '#e6dccb', roughness: 0.95, metalness: 0, use: 'wall' },
  { id: 'brick', name: 'Red brick', color: '#a65a3c', roughness: 0.9, metalness: 0, use: 'wall' },
  { id: 'concrete', name: 'Board-marked concrete', color: '#b9b6b0', roughness: 0.85, metalness: 0, use: 'wall' },
  { id: 'timber-clad', name: 'Charred timber', color: '#3b3330', roughness: 0.8, metalness: 0, use: 'wall' },
  { id: 'curtain', name: 'Glass curtain wall', color: '#7fa6bf', roughness: 0.08, metalness: 0.35, use: 'wall' },
  { id: 'cladding', name: 'Ribbed metal cladding', color: '#c3c8cc', roughness: 0.45, metalness: 0.55, use: 'wall' },
  { id: 'cladding-dark', name: 'Dark metal cladding', color: '#3d454d', roughness: 0.45, metalness: 0.55, use: 'wall' },
  { id: 'white-panel', name: 'White composite panel', color: '#eef0f1', roughness: 0.5, metalness: 0.1, use: 'wall' },
  { id: 'oak', name: 'Oak boards', color: '#c39a6b', roughness: 0.6, metalness: 0, use: 'floor' },
  { id: 'walnut', name: 'Walnut parquet', color: '#6f4e3a', roughness: 0.55, metalness: 0, use: 'floor' },
  { id: 'tile', name: 'Porcelain tile', color: '#d8d3ca', roughness: 0.35, metalness: 0, use: 'floor' },
  { id: 'terrazzo', name: 'Terrazzo', color: '#e4dfd6', roughness: 0.4, metalness: 0, use: 'floor' },
  { id: 'screed', name: 'Polished screed', color: '#9e9b96', roughness: 0.3, metalness: 0, use: 'floor' },
  { id: 'epoxy', name: 'Epoxy factory floor', color: '#8fa3a8', roughness: 0.25, metalness: 0, use: 'floor' },
  { id: 'carpet', name: 'Office carpet tiles', color: '#6b7580', roughness: 1, metalness: 0, use: 'floor' },
  { id: 'glass', name: 'Clear glazing', color: '#cfe8f3', roughness: 0.05, metalness: 0, use: 'glass' },
  { id: 'frame', name: 'Anthracite frame', color: '#37404a', roughness: 0.5, metalness: 0.4, use: 'frame' },
  { id: 'fabric', name: 'Wool fabric', color: '#7d8a96', roughness: 1, metalness: 0, use: 'fabric' },
  { id: 'ash', name: 'Ash joinery', color: '#d8c3a5', roughness: 0.7, metalness: 0, use: 'wood' },
  { id: 'roof-tile', name: 'Clay tiles', color: '#9c4a32', roughness: 0.85, metalness: 0, use: 'roof' },
  { id: 'roof-slate', name: 'Slate', color: '#4a5058', roughness: 0.7, metalness: 0.05, use: 'roof' },
  { id: 'roof-metal', name: 'Standing-seam metal', color: '#6f7a85', roughness: 0.4, metalness: 0.6, use: 'roof' },
  { id: 'roof-green', name: 'Green (sedum) roof', color: '#6b8f4e', roughness: 1, metalness: 0, use: 'roof' },
  { id: 'roof-membrane', name: 'Light membrane', color: '#c9c6bf', roughness: 0.9, metalness: 0, use: 'roof' },
];

export const materialById = (id: string) => MATERIALS.find((m) => m.id === id) ?? MATERIALS[0];
export const wallMaterials = MATERIALS.filter((m) => m.use === 'wall');
export const floorMaterials = MATERIALS.filter((m) => m.use === 'floor');
export const roofMaterials = MATERIALS.filter((m) => m.use === 'roof');

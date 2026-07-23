import sharp from 'sharp';
import path from 'path';

const root = path.resolve('static');
const svg = path.join(root, 'favicon.svg');

await sharp(svg)
  .resize(192, 192, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(root, 'icon-192.png'));

await sharp(svg)
  .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(root, 'icon-512.png'));

console.log('Generated static/icon-192.png and static/icon-512.png from favicon.svg');

/* global console */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const BRANDING_DIR = path.resolve(process.cwd(), 'assets/branding');
const ICONS_DIR = path.resolve(process.cwd(), 'public/icons');

fs.mkdirSync(ICONS_DIR, { recursive: true });

async function main() {
  console.log('Generating PNG icons from assets/branding/ SVGs via Sharp...');

  // 1. Application / Store Icons (Full Charcoal Tile)
  const appSizes = [128, 48, 32, 16];
  for (const size of appSizes) {
    const svgPath = path.join(BRANDING_DIR, `submitlog-icon-${size}.svg`);
    if (!fs.existsSync(svgPath)) {
      throw new Error(`SVG source not found: ${svgPath}`);
    }

    const svgBuffer = fs.readFileSync(svgPath);
    const pngPath = path.join(ICONS_DIR, `icon-${size}.png`);

    await sharp(svgBuffer).resize(size, size).png({ compressionLevel: 9 }).toFile(pngPath);
    console.log(`Generated: ${pngPath}`);
  }

  // 2. Toolbar-Specific Icons (Transparent Background Glyph)
  const toolbarSizes = [32, 16];
  for (const size of toolbarSizes) {
    const svgPath = path.join(BRANDING_DIR, `submitlog-toolbar-${size}.svg`);
    if (!fs.existsSync(svgPath)) {
      throw new Error(`Toolbar SVG source not found: ${svgPath}`);
    }

    const svgBuffer = fs.readFileSync(svgPath);
    const pngPath = path.join(ICONS_DIR, `toolbar-${size}.png`);

    await sharp(svgBuffer).resize(size, size).png({ compressionLevel: 9 }).toFile(pngPath);
    console.log(`Generated toolbar icon: ${pngPath}`);
  }

  console.log('Icon generation complete. All runtime PNG icons written to public/icons/.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

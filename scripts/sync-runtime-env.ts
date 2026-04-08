import fs from 'fs';
import path from 'path';

const projectRoot = process.cwd();
const sourceEnv = path.join(projectRoot, '.env');
const targetDir = path.join(projectRoot, 'data', 'env');
const targetEnv = path.join(targetDir, 'env');

fs.mkdirSync(targetDir, { recursive: true });

if (fs.existsSync(sourceEnv)) {
  fs.copyFileSync(sourceEnv, targetEnv);
  console.log('Synced .env to data/env/env');
} else {
  if (fs.existsSync(targetEnv)) {
    fs.rmSync(targetEnv);
    console.log('Removed stale data/env/env because .env is missing');
  } else {
    console.log('No .env found; runtime env already absent');
  }
}

import {defineConfig} from 'vitest/config';
import {freeTestPort} from '../../scripts/test-network.js';
export default defineConfig(async()=>({server:{hmr:{port:await freeTestPort()}}}));

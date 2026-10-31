import {defineConfig} from 'vitest/config';
import {isolatedTestNetwork} from '../../scripts/test-network.js';
export default defineConfig({plugins:[isolatedTestNetwork()]});

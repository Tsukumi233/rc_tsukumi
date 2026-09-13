import { createMockProvider } from './provider.js';
import { log } from '../src/log.js';

if (process.env.NODE_ENV === 'production') throw new Error('Mock provider is for development only');
const provider = createMockProvider();
await provider.listen(Number(process.env.MOCK_PORT ?? 4000), '0.0.0.0');
log('mock_provider_started', { port: Number(process.env.MOCK_PORT ?? 4000) });
process.once('SIGTERM', () => void provider.close());
process.once('SIGINT', () => void provider.close());

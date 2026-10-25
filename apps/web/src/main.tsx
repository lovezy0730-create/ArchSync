import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App.js';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

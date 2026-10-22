// Side panel entry: mounts the React app into index.html's #root.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('smrzr: #root element missing in sidepanel/index.html');

// StrictMode runs effects twice in development to surface missing cleanups; production is unaffected.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

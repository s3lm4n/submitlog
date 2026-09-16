import React from 'react';
import ReactDOM from 'react-dom/client';
import { Archive } from './Archive';
import '../styles/global.css';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <Archive />
    </React.StrictMode>,
  );
}

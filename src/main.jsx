import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App.jsx';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

// Desktop feel: keep the native context menu only where text can be selected.
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea, .selectable, .mono, code')) e.preventDefault();
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

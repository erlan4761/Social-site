import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTheme } from './theme';
import './styles.css';

// Inline-скрипт в index.html уже поставил data-theme до первой отрисовки;
// здесь тот же выбор подтверждается и заводится слежение за системной темой
// для режима «как в системе».
initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

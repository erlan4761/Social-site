import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTheme } from './theme';
import { captureInstallPrompt, registerServiceWorker } from './pwa';
import './styles.css';

// Inline-скрипт в index.html уже поставил data-theme до первой отрисовки;
// здесь тот же выбор подтверждается и заводится слежение за системной темой
// для режима «как в системе».
initTheme();

// Установка на экран «Домой» и пуш-уведомления (pwa.ts, public/sw.js).
captureInstallPrompt();
registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

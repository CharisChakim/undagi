// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { ConnectionsProvider } from './lib/connections.tsx';
import { hydratePrefs } from './lib/prefs';

// Theme, language and layout are read while the first render runs, so the
// stored preferences load first. It never throws, and gives up after 3 s.
void hydratePrefs().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ConnectionsProvider>
        <App />
      </ConnectionsProvider>
    </StrictMode>,
  );
});

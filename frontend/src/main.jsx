import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeContext';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { ScrapingProvider } from './context/ScrapingContext';
import App from './App';
import { installCapture } from './components/testNotes/testNotesCapture';

// Captura de errores para las notas de prueba (antes del render para no perder los primeros)
installCapture({ ignore: url => url.includes('/api/test-notes') });

// Registrar Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
            console.log('⚠️ Service Worker no registrado');
        });
    });
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <BrowserRouter>
            <ThemeProvider>
                <AuthProvider>
                    <ToastProvider>
                        <ScrapingProvider>
                            <App />
                        </ScrapingProvider>
                    </ToastProvider>
                </AuthProvider>
            </ThemeProvider>
        </BrowserRouter>
    </React.StrictMode>
);

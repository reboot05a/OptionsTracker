import cors from 'cors';
import express from 'express';

const isProduction = process.env.NODE_ENV === 'production';

export const registerMiddleware = (app) => {
    // CORS: restrict to same origin in production, allow all in dev
    if (isProduction) {
        app.use(cors({ origin: false }));
    } else {
        app.use(cors());
    }

    app.use(express.json());

    // Security headers
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-XSS-Protection', '0');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        if (isProduction) {
            res.setHeader('Content-Security-Policy', [
                "default-src 'self'",
                // 'unsafe-inline' needed for the dark-mode inline script in index.html
                "script-src 'self' 'unsafe-inline' https://s3.tradingview.com",
                // Google Fonts stylesheet + unsafe-inline for scoped JSX <style> blocks
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
                // Google Fonts actual font files are served from gstatic.com
                "font-src 'self' https://fonts.gstatic.com",
                "img-src 'self' data: https://*.tradingview.com",
                // TradingView widget injects iframes from multiple TV-owned origins
                "frame-src 'self' https://s3.tradingview.com https://www.tradingview.com https://www.tradingview-widget.com https://*.tradingview-widget.com",
                // TradingView live chart uses HTTPS + WebSocket connections
                "connect-src 'self' https://*.tradingview.com wss://*.tradingview.com",
            ].join('; '));
        }
        next();
    });

    // Request ID middleware
    app.use((req, res, next) => {
        req.requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        next();
    });

    // Disable X-Powered-By header (hides Express)
    app.disable('x-powered-by');
};

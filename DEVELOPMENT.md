# Development Setup Guide

## Backend & Frontend Servers

### Ports
- **Frontend (Vite)**: http://localhost:3000 (or 3001 if 3000 is in use)
- **Backend (API)**: http://localhost:3002
- **Proxy**: API requests from frontend are automatically proxied to backend via Vite

### Running Development Servers

#### Option 1: Run Both (Recommended)
```bash
npm run dev:all
```
This starts both the backend API server (port 3002) and frontend dev server (port 3000/3001) simultaneously using `concurrently`.

#### Option 2: Run Separately (in different terminals)
```bash
# Terminal 1 - Backend API Server
npm run dev:backend

# Terminal 2 - Frontend Dev Server
npm run dev:frontend
```

#### Option 3: Frontend Only (requires backend to be running separately)
```bash
npm run dev
```

### How It Works

1. **Frontend** makes a request to `/api/verify-face`
2. **Vite Dev Server** intercepts the request via proxy configuration
3. **Proxy** forwards it to `http://localhost:3002/api/verify-face`
4. **Backend Server** handles the request and calls the Aadrila API
5. **Response** is sent back to frontend

### Environment Variables

The backend server reads from `.env.local`:
- `AADRILA_API_URL` - Aadrila API endpoint
- `AADRILA_BEARER_TOKEN` - Aadrila Bearer token
- `VITE_AADRILA_BEARER_TOKEN` - Frontend Bearer token (if needed)
- `VITE_SIMILARITY_THRESHOLD` - Face match threshold
- `VITE_IMAGE_TYPE` - Image type for Aadrila API

### Troubleshooting

**Port Already in Use**
```bash
# Kill process on port 3001
lsof -i :3001 | grep LISTEN | awk '{print $2}' | xargs kill -9

# Kill process on port 3002
lsof -i :3002 | grep LISTEN | awk '{print $2}' | xargs kill -9
```

**API Returns 404**
- Ensure backend server is running (`npm run dev:backend`)
- Check that Vite proxy is configured correctly in `vite.config.ts`
- Verify `.env.local` has correct `AADRILA_*` variables

**Testing API Directly**
```bash
curl http://localhost:3002/api/health
# Should return: {"status":"ok","message":"API server is running"}
```

### Production Deployment (Vercel)

For production, use the serverless API function at `/api/verify-face.ts` (not this local server). Vercel automatically deploys it.

Set these environment variables in Vercel:
- `AADRILA_API_URL`
- `AADRILA_BEARER_TOKEN`
- `VITE_AADRILA_BEARER_TOKEN`
- `VITE_SIMILARITY_THRESHOLD`
- `VITE_IMAGE_TYPE`

# Vercel Deployment Guide

## Setting Environment Variables in Vercel

### Step 1: Go to Vercel Project Settings

1. Visit [vercel.com/dashboard](https://vercel.com/dashboard)
2. Select your project
3. Click **Settings** → **Environment Variables**

### Step 2: Add the Required Environment Variables

Add each of these variables one by one. They should match your `.env.local` file:

#### Frontend Variables (Public - Sent to Browser)
These start with `VITE_` and are accessible in the browser:

| Variable | Value | Example |
|----------|-------|---------|
| `VITE_AADRILA_BEARER_TOKEN` | Your Aadrila API bearer token | `a1ccef123762795909edf8cf905ab3c4` |
| `VITE_SIMILARITY_THRESHOLD` | Face match threshold (0-100) | `75` |
| `VITE_IMAGE_TYPE` | Image type identifier | `1` |

#### Backend Variables (Secret - Server-Side Only)
These are NOT prefixed with `VITE_` and only exist on the server:

| Variable | Value | Example |
|----------|-------|---------|
| `AADRILA_API_URL` | Aadrila API endpoint | `https://uat.aadrila.com/api/v1/verify-face` |
| `AADRILA_BEARER_TOKEN` | Your Aadrila API bearer token | `a1ccef123762795909edf8cf905ab3c4` |

### Step 3: Configure Each Variable

For each variable:
1. Click **Add New**
2. Enter the **Name** (e.g., `VITE_AADRILA_BEARER_TOKEN`)
3. Enter the **Value** (your actual token/URL)
4. For frontend variables: Select **Production** and **Preview**
5. For backend variables: Select **Production** and **Preview**
6. Click **Save**

### Step 4: Verify Variables Are Set

After adding all variables:
1. Click **Deployments**
2. Trigger a new deployment (Git push or redeploy)
3. Wait for deployment to complete

### Troubleshooting 401 Error

**If you still get 401 error after deploying:**

1. **Check bearer token is correct**
   - Copy it exactly from Aadrila (no extra spaces or characters)
   - Both `VITE_AADRILA_BEARER_TOKEN` and `AADRILA_BEARER_TOKEN` should be identical

2. **Verify variables are accessible**
   - Add this temporary debugging in `api/verify-face.ts`:
   ```typescript
   console.log('Token exists:', !!process.env.AADRILA_BEARER_TOKEN);
   console.log('API URL:', process.env.AADRILA_API_URL);
   ```
   - Check Vercel deployment logs

3. **Force redeploy**
   - Go to Vercel dashboard
   - Click **Deployments**
   - Click the three dots on latest deployment
   - Select **Redeploy**
   - Wait for new deployment to complete

4. **Check browser developer console**
   - The API response should include debugging info:
   ```json
   {
     "debug": {
       "statusCode": 401,
       "tokenSource": "frontend|environment",
       "apiUrl": "https://..."
     }
   }
   ```
   - If `tokenSource` is "frontend", the backend environment variable wasn't set

### Quick Checklist

- [ ] All 5 environment variables added to Vercel
- [ ] Bearer token is correct (not expired, not truncated)
- [ ] Variables are set for both Production and Preview environments
- [ ] Deployment is complete (check deployment logs)
- [ ] Cleared browser cache (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows)
- [ ] Tried in incognito/private window to avoid cache issues

### Still Getting 401?

1. **Check if Aadrila API is accessible**
   ```bash
   # Test the API directly with correct token
   curl -X POST https://uat.aadrila.com/api/v1/verify-face \
     -H "Authorization: Bearer YOUR_TOKEN_HERE" \
     -F "docFile=@id.jpg" \
     -F "user_photo=@face.jpg" \
     -F "SimilarityThreshold=75" \
     -F "ImageType=1"
   ```

2. **Check token format**
   - Should be just the token, not "Bearer token"
   - No quotes or special characters
   - Verify from Aadrila that token hasn't expired

3. **Check API endpoint**
   - Verify `AADRILA_API_URL` is correct: `https://uat.aadrila.com/api/v1/verify-face`
   - If different environment (prod vs uat), update the URL

### Environment Variables Summary

**Local Development (`.env.local`)**
```env
VITE_AADRILA_BEARER_TOKEN=a1ccef123762795909edf8cf905ab3c4
VITE_SIMILARITY_THRESHOLD=75
VITE_IMAGE_TYPE=1
AADRILA_API_URL=https://uat.aadrila.com/api/v1/verify-face
AADRILA_BEARER_TOKEN=a1ccef123762795909edf8cf905ab3c4
```

**Vercel Dashboard (Settings → Environment Variables)**
- `VITE_AADRILA_BEARER_TOKEN` = `a1ccef123762795909edf8cf905ab3c4`
- `VITE_SIMILARITY_THRESHOLD` = `75`
- `VITE_IMAGE_TYPE` = `1`
- `AADRILA_API_URL` = `https://uat.aadrila.com/api/v1/verify-face`
- `AADRILA_BEARER_TOKEN` = `a1ccef123762795909edf8cf905ab3c4`

After setting all variables and redeploying, the 401 error should be resolved!

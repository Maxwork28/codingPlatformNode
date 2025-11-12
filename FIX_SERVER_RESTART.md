# Fix Server Restart Issue

## Problem
The server restarts when testing solutions because nodemon detects file changes in the `temp/` directory, causing requests to fail with `ERR_CONNECTION_REFUSED`.

## Solution
Created `nodemon.json` to ignore the `temp/` directory and other non-source files.

## What to Do

### 1. Restart the Server
The server needs to be restarted for nodemon to pick up the new configuration:

```powershell
# Stop the current server (Ctrl+C)
# Then restart:
cd pu/codingPlatformNode
npm run dev
```

### 2. Verify Configuration
The `nodemon.json` file should ignore:
- `temp/**/*` - Temporary files created during code execution
- `node_modules/**/*` - Dependencies
- `docker/**/*` - Docker files
- `*.log` - Log files
- `*.md` - Markdown files

### 3. Test Again
After restarting the server, test a solution again. The server should no longer restart during code execution.

## Additional Notes

### Language Mismatch
If you're testing code:
- Make sure the **Solution Language** dropdown matches the code you're testing
- Python code (`a, b = map(int, input().split())`) should use **Python** language
- JavaScript code should use **JavaScript** language
- The language selector is in the "Solution Code (Optional)" section

### Current Status
- ✅ `nodemon.json` created
- ✅ `temp/` directory ignored
- ⏳ Server needs to be restarted
- ⏳ Test again after restart

## If Issue Persists

1. **Check nodemon.json exists:**
   ```powershell
   cd pu/codingPlatformNode
   cat nodemon.json
   ```

2. **Verify temp directory is ignored:**
   The nodemon.json should have `"ignore": ["temp/**/*", ...]`

3. **Check server logs:**
   After restart, you should see:
   ```
   [nodemon] starting `node server.js`
   MongoDB connected
   Server started on port 3000
   ```

4. **Test with a simple solution:**
   Try testing a simple JavaScript solution first to verify the fix works.


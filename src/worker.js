/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

class RequestTrace {
  constructor(id, method, url) {
    this.id = id;
    this.method = method;
    this.url = url;
    this.startTime = Date.now();
    this.steps = [];
  }

  log(message) {
    const elapsed = Date.now() - this.startTime;
    this.steps.push(`[+${elapsed}ms] ${message}`);
  }

  error(message, err) {
    const elapsed = Date.now() - this.startTime;
    const errDetails = err ? `: ${err.message || err}` : "";
    this.steps.push(`[+${elapsed}ms] ERROR: ${message}${errDetails}`);
  }

  flush(status = 200) {
    const duration = Date.now() - this.startTime;
    console.log(
      `[TRACE] ID: ${this.id} | ${this.method} ${this.url} | Status: ${status} | Duration: ${duration}ms\n` +
      this.steps.map(step => `  ${step}`).join("\n")
    );
  }
}

export default {
  // Inside your secure backend API environment (e.g., /api/token)
  async fetch(request, env, ctx) {
    const requestId = request.headers.get("cf-ray") || Math.random().toString(36).substring(2, 10);
    const trace = new RequestTrace(requestId, request.method, request.url);
    let responseStatus = 200;

    try {
      const incomingUrl = new URL(request.url);
      const path = incomingUrl.pathname;
      const searchParams = incomingUrl.searchParams;

      trace.log(`Routing path: ${path}`);

      // Route 1: /redirect
      if (path === "/redirect") {
        trace.log("Handling /redirect request");
        const pluginId = searchParams.get("state") || "obsidian_drive_sync";
        const targetBase = `obsidian://${pluginId}`;
        const destinationUrl = `${targetBase}${incomingUrl.search}`;
        trace.log(`Redirecting to: ${destinationUrl}`);

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Obsidian Drive Sync Auth</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f5f6; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 450px; box-sizing: border-box; text-align: center; }
        h1 { color: #2d3748; font-size: 1.5rem; margin-bottom: 1rem; }
        p { color: #4a5568; line-height: 1.5; font-size: 0.95rem; margin-bottom: 1.5rem; }
        .btn { display: inline-block; background: #4f46e5; color: white; padding: 0.75rem 1.5rem; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 0.95rem; border: none; cursor: pointer; transition: background 0.2s; }
        .btn:hover { background: #4338ca; }
        .hint { font-size: 0.8rem; color: #718096; margin-top: 1rem; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Authentication Successful</h1>
        <p>Your Google Drive credentials have been verified. Your browser should prompt you to open Obsidian. If not, click the button below.</p>
        <a href="${escapeHtml(destinationUrl)}" class="btn">Open Obsidian</a>
        <p class="hint">You can safely close this window once the redirect completes.</p>
    </div>
    <script>
        // Automatically attempt to redirect to Obsidian
        window.location.href = "${destinationUrl.replace(/"/g, '\\"')}";
    </script>
</body>
</html>`;

        responseStatus = 200;
        return new Response(html, {
          headers: {
            "Content-Type": "text/html;charset=UTF-8",
            "Cache-Control": "no-cache"
          }
        });
      }

      // Route 2: /display
      else if (path === "/display") {
        trace.log("Handling /display request");
        const errorParam = searchParams.get("error");
        const codeParam = searchParams.get("code") || "";
        const pluginId = searchParams.get("state") || "obsidian_drive_sync";
        const displayName = pluginId
          .split(/[_-]/)
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");

        let contentHtml = "";

        // Conditional UI logic based on parameters
        if (errorParam) {
          trace.log(`Displaying error page: ${errorParam}`);
          contentHtml = `
            <div class="error-box">
              <strong>Error:</strong> ${escapeHtml(errorParam)}
            </div>
          `;
        } else {
          trace.log("Displaying auth code page");
          contentHtml = `
            <label for="code-input">Authorization Code:</label>
            <input type="text" id="code-input" value="${escapeHtml(codeParam)}" readonly onclick="navigator.clipboard.writeText()">
            <p class="hint">Click inside the box to select and copy the code.</p>
          `;
        }

        // Return a clean, styled HTML page
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${displayName} Auth</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f5f6; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 400px; box-sizing: border-box; }
        .error-box { background: #fff5f5; color: #e53e3e; border: 1px solid #fed7d7; padding: 1rem; border-radius: 6px; font-size: 0.95rem; line-height: 1.4; }
        label { display: block; font-weight: 600; margin-bottom: 0.5rem; color: #4a5568; }
        input[type="text"] { width: 100%; padding: 0.75rem; border: 1px solid #cbd5e0; border-radius: 6px; font-family: monospace; font-size: 1rem; box-sizing: border-box; background: #f7fafc; }
        .hint { font-size: 0.8rem; color: #718096; margin-top: 0.5rem; }
    </style>
</head>
<body>
    <div class="card">
        ${contentHtml}
    </div>
</body>
</html>`;

        responseStatus = 200;
        return new Response(html, {
          headers: { "Content-Type": "text/html;charset=UTF-8" }
        });
      }

      // Route 3: /token redirect
      else if (path === "/token") {
        trace.log("Handling /token request");
        // Only allow POST requests for exchanging tokens
        if (request.method !== "POST") {
          trace.error(`Method Not Allowed: ${request.method}`);
          responseStatus = 405;
          return new Response("Method Not Allowed", { status: 405 });
        }

        try {
          // Parse the JSON body payload passed by your Obsidian plugin
          const formData = await request.formData();
          const grantType = formData.get("grant_type") || "authorization_code";
          const client_id = formData.get("client_id");

          trace.log(`Token grant type: ${grantType}, client_id: ${client_id}`);

          let tokenRequestBody;

          if (grantType === "refresh_token") {
            const refresh_token = formData.get("refresh_token");
            if (!refresh_token || !client_id) {
              trace.error("Missing required parameters (refresh_token or client_id)");
              responseStatus = 400;
              return new Response(
                JSON.stringify({ error: "Missing required parameters (refresh_token or client_id)" }), 
                { status: 400, headers: { "Content-Type": "application/json" } }
              );
            }

            tokenRequestBody = new URLSearchParams({
              client_id: client_id,
              client_secret: env.GOOGLE_CLIENT_SECRET,
              refresh_token: refresh_token,
              grant_type: "refresh_token"
            });
          } else if (grantType === "authorization_code") {
            const code = formData.get("code");
            const code_verifier = formData.get("code_verifier");
            const redirect_uri = formData.get("redirect_uri");

            trace.log(`Parsed authorization code parameters: code?=${!!code}, verifier?=${!!code_verifier}`);

            if (!code || !code_verifier || !client_id) {
              trace.error("Missing required parameters (code, code_verifier, or client_id)");
              responseStatus = 400;
              return new Response(
                JSON.stringify({ error: "Missing required parameters (code, code_verifier, or client_id)" }), 
                { status: 400, headers: { "Content-Type": "application/json" } }
              );
            }

            tokenRequestBody = new URLSearchParams({
              client_id: client_id,
              client_secret: env.GOOGLE_CLIENT_SECRET,
              code: code,
              code_verifier: code_verifier,
              grant_type: "authorization_code",
              redirect_uri: redirect_uri
            });
          } else {
            trace.error(`Unsupported grant type: ${grantType}`);
            responseStatus = 400;
            return new Response(
              JSON.stringify({ error: `Unsupported grant type: ${grantType}` }), 
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }

          const googleTokenUrl = "https://oauth2.googleapis.com/token";
          trace.log("Forwarding request to Google Token endpoint");

          // Forward to Google's Token Endpoint
          const googleResponse = await fetch(googleTokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequestBody.toString()
          });

          responseStatus = googleResponse.status;
          trace.log(`Received Google response status: ${googleResponse.status}`);

          const tokenData = await googleResponse.json();
          if (googleResponse.status === 200) {
            trace.log("Token request successful");
          } else {
            trace.error(`Token request failed. Response details: ${JSON.stringify(tokenData)}`);
          }

          // Return Google's response back to your Obsidian plugin
          return new Response(JSON.stringify(tokenData), {
            status: googleResponse.status,
            headers: { 
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*" // Allow Obsidian to receive this response cross-origin
            }
          });

        } catch (error) {
          trace.error("Failed handling token request", error);
          responseStatus = 500;
          return new Response(
            JSON.stringify({ error: "Server Error processing token request", details: error.message }), 
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      // Fallback for any other path (e.g., root /)
      trace.log(`Path not found: ${path}`);
      responseStatus = 404;
      return new Response("Not Found", { status: 404 });

    } catch (err) {
      trace.error("Unhandled request error", err);
      responseStatus = 500;
      return new Response(
        JSON.stringify({ error: "Internal Server Error", details: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    } finally {
      trace.flush(responseStatus);
    }
  }
};

// Helper function to prevent XSS attacks when reflecting query parameters into HTML
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

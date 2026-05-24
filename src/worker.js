/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
export default {
  // Inside your secure backend API environment (e.g., /api/token)
  async fetch(request, env, ctx) {
    const incomingUrl = new URL(request.url);
    const path = incomingUrl.pathname;
    const searchParams = incomingUrl.searchParams;

    console.info('Start fetch')

    // Route 1: /redirect
    if (path === "/redirect") {
      console.info('Redirect')
      const pluginId = searchParams.get("state") || "obsidian_drive_sync";
      const targetBase = `obsidian://${pluginId}`;
      const destinationUrl = `${targetBase}${incomingUrl.search}`;
      
      return new Response(null, {
        status: 301,
        headers: {
          "Location": destinationUrl,
          "Cache-Control": "no-cache"
        }
      });
    }

    // Route 2: /display
    else if (path === "/display") {
      console.info("Display")
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
        contentHtml = `
          <div class="error-box">
            <strong>Error:</strong> ${escapeHtml(errorParam)}
          </div>
        `;
      } else {
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

      return new Response(html, {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    // Route 3: /token redirect
    else if (path === "/token") {
      console.info(`Token ${request.method}`);
      // Only allow POST requests for exchanging tokens
      if (request.method !== "POST") {
        console.error("Wrong Method");
        return new Response("Method Not Allowed", { status: 405 });
      }

      try {
        // Parse the JSON body payload passed by your Obsidian plugin
        const formData = await request.formData();
 
        // Extract the parameters using .get()
        const code = formData.get("code");
        const code_verifier = formData.get("code_verifier");
        const client_id = formData.get("client_id");
        const redirect_uri = formData.get("redirect_uri");

        if (!code || !code_verifier || !client_id) {
          return new Response("Missing parameters", { status: 400 });
        }
        console.info(`Start request ${code} for client_id ${client_id}`);

        // Basic validation
        if (!code || !code_verifier || !client_id) {
          console.error(`Missing Parameters`);
          return new Response(
            JSON.stringify({ error: "Missing required parameters (code, code_verifier, or client_id)" }), 
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        // Construct form data payload for Google API (Google expects application/x-www-form-urlencoded)
        const googleTokenUrl = "https://oauth2.googleapis.com/token";
        const tokenRequestBody = new URLSearchParams({
          client_id: client_id,
          client_secret: env.GOOGLE_CLIENT_SECRET, // Injected securely from Cloudflare Env variables
          code: code,
          code_verifier: code_verifier,
          grant_type: "authorization_code",
          redirect_uri: redirect_uri // Matches what was used to request the authorization code
        });
        console.info(`Token Request ${tokenRequestBody.toString()}`);

        // Forward to Google's Token Endpoint
        const googleResponse = await fetch(googleTokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenRequestBody.toString()
        });

        const tokenData = await googleResponse.json();
        console.info(tokenData);

        // Return Google's response back to your Obsidian plugin
        return new Response(JSON.stringify(tokenData), {
          status: googleResponse.status,
          headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*" // Allow Obsidian to receive this response cross-origin
          }
        });

      } catch (error) {
        console.error(`Failed Request ${error.message}`);
        return new Response(
          JSON.stringify({ error: "Server Error processing token swap", details: error.message }), 
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }


    // Fallback for any other path (e.g., root /)
    return new Response("Not Found", { status: 404 });
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

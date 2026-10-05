import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Global Netlify mock for local testing
globalThis.Netlify = {
  env: {
    _vars: new Map(),
    get(key) {
      return this._vars.get(key);
    },
    set(key, value) {
      this._vars.set(key, value);
    },
    delete(key) {
      this._vars.delete(key);
    },
    has(key) {
      return this._vars.has(key);
    },
  },
};

// Import function handler
const { default: handler } = await import("../netlify/functions/submission-created.mts");

describe("submission-created function", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    Netlify.env._vars.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns 200 and ignores if no payload is present", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await handler(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.message, "No payload found");
  });

  test("ignores form submissions from forms other than 'contact'", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          form_name: "newsletter",
          data: { email: "newsletter@example.com" },
        },
      }),
    });

    const res = await handler(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.message, "Ignored form");
  });

  test("returns 200 when Zoho credentials are not configured", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          form_name: "contact",
          data: {
            name: "John Doe",
            email: "john@example.com",
            message: "Hello world",
          },
        },
      }),
    });

    const res = await handler(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.match(data.message, /Zoho CRM credentials not configured/);
  });

  test("authenticates and creates lead in Zoho CRM on valid submission", async () => {
    Netlify.env.set("ZOHO_CLIENT_ID", "mock_client_id");
    Netlify.env.set("ZOHO_CLIENT_SECRET", "mock_client_secret");
    Netlify.env.set("ZOHO_REFRESH_TOKEN", "mock_refresh_token");
    Netlify.env.set("ZOHO_ACCOUNTS_URL", "https://accounts.zoho.com");
    Netlify.env.set("ZOHO_API_DOMAIN", "https://www.zohoapis.com");

    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/oauth/v2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "mock_access_token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/crm/v6/Leads")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                code: "SUCCESS",
                details: { id: "987654321" },
                message: "record added",
                status: "success",
              },
            ],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          form_name: "contact",
          data: {
            name: "Eleanor Vance",
            email: "eleanor@example.com",
            message: "I need consultation on brand identity.",
          },
        },
      }),
    });

    const res = await handler(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(calls.length, 2);

    // Verify token call
    assert.equal(calls[0].url, "https://accounts.zoho.com/oauth/v2/token");
    assert.match(calls[0].options.body, /grant_type=refresh_token/);
    assert.match(calls[0].options.body, /client_id=mock_client_id/);

    // Verify lead creation call
    assert.equal(calls[1].url, "https://www.zohoapis.com/crm/v6/Leads");
    assert.equal(calls[1].options.headers["Authorization"], "Zoho-oauthtoken mock_access_token");

    const leadPayload = JSON.parse(calls[1].options.body);
    const record = leadPayload.data[0];
    assert.equal(record.First_Name, "Eleanor");
    assert.equal(record.Last_Name, "Vance");
    assert.equal(record.Company, "Eleanor Vance");
    assert.equal(record.Email, "eleanor@example.com");
    assert.equal(record.Description, "I need consultation on brand identity.");
    assert.equal(record.Lead_Source, "Website Contact Form");
  });

  test("handles Zoho OAuth failure properly", async () => {
    Netlify.env.set("ZOHO_CLIENT_ID", "mock_client_id");
    Netlify.env.set("ZOHO_CLIENT_SECRET", "mock_client_secret");
    Netlify.env.set("ZOHO_REFRESH_TOKEN", "mock_refresh_token");

    globalThis.fetch = async (url) => {
      if (url.includes("/oauth/v2/token")) {
        return new Response(
          JSON.stringify({
            error: "invalid_client",
            error_description: "Client authentication failed",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          form_name: "contact",
          data: {
            name: "Test User",
            email: "test@example.com",
            message: "Test message",
          },
        },
      }),
    });

    const res = await handler(req);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "Failed to authenticate with Zoho CRM");
    assert.equal(body.details, "Client authentication failed");
  });

  test("handles Zoho CRM API error response properly", async () => {
    Netlify.env.set("ZOHO_CLIENT_ID", "mock_client_id");
    Netlify.env.set("ZOHO_CLIENT_SECRET", "mock_client_secret");
    Netlify.env.set("ZOHO_REFRESH_TOKEN", "mock_refresh_token");

    globalThis.fetch = async (url) => {
      if (url.includes("/oauth/v2/token")) {
        return new Response(
          JSON.stringify({ access_token: "mock_token" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/crm/v6/Leads")) {
        return new Response(
          JSON.stringify({
            code: "MANDATORY_NOT_FOUND",
            message: "required field not found",
            status: "error",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          form_name: "contact",
          data: {
            name: "Test User",
            email: "test@example.com",
            message: "Test message",
          },
        },
      }),
    });

    const res = await handler(req);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "Failed to create lead in Zoho CRM");
  });
});

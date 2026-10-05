interface FormPayload {
  form_name: string;
  data: {
    name?: string;
    email?: string;
    message?: string;
    [key: string]: string | undefined;
  };
  created_at?: string;
}

interface SubmissionEventBody {
  payload: FormPayload;
}

export default async (req: Request) => {
  try {
    const body = (await req.json()) as SubmissionEventBody;
    const payload = body?.payload;

    if (!payload || !payload.data) {
      console.warn("Zoho CRM integration: Received submission-created event without payload or data.");
      return new Response(JSON.stringify({ message: "No payload found" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only process submissions from the "contact" form on index.html
    if (payload.form_name && payload.form_name !== "contact") {
      console.log(`Zoho CRM integration: Ignoring non-contact form '${payload.form_name}'.`);
      return new Response(JSON.stringify({ message: "Ignored form" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { name, email, message } = payload.data;

    // Retrieve environment variables via Netlify.env
    const clientId = Netlify.env.get("ZOHO_CLIENT_ID");
    const clientSecret = Netlify.env.get("ZOHO_CLIENT_SECRET");
    const refreshToken = Netlify.env.get("ZOHO_REFRESH_TOKEN");
    const accountsUrl = Netlify.env.get("ZOHO_ACCOUNTS_URL") || "https://accounts.zoho.com";
    const apiDomain = Netlify.env.get("ZOHO_API_DOMAIN") || "https://www.zohoapis.com";

    if (!clientId || !clientSecret || !refreshToken) {
      console.warn(
        "Zoho CRM integration: Missing one or more required environment variables (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN). Skipping Zoho CRM lead sync."
      );
      return new Response(
        JSON.stringify({
          message: "Zoho CRM credentials not configured. Please set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN in Netlify.",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 1. Request a fresh access token from Zoho OAuth using the refresh token
    const tokenParams = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    });

    const tokenUrl = `${accountsUrl.replace(/\/+$/, "")}/oauth/v2/token`;
    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenParams.toString(),
    });

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("Zoho CRM OAuth error during token refresh:", tokenData);
      return new Response(
        JSON.stringify({
          error: "Failed to authenticate with Zoho CRM",
          details: tokenData.error_description || tokenData.error || "Unknown token error",
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 2. Format name into First_Name and Last_Name (Zoho requires Last_Name and Company)
    const rawName = (name || "").trim();
    let firstName = "";
    let lastName = "Website Inquiry";

    if (rawName) {
      const parts = rawName.split(/\s+/);
      if (parts.length === 1) {
        lastName = parts[0];
      } else {
        firstName = parts.slice(0, -1).join(" ");
        lastName = parts[parts.length - 1];
      }
    }

    const leadRecord: Record<string, any> = {
      Last_Name: lastName,
      Company: rawName || "Not Provided",
      Email: email || undefined,
      Description: message || undefined,
      Lead_Source: "Website Contact Form",
    };

    if (firstName) {
      leadRecord.First_Name = firstName;
    }

    const leadPayload = {
      data: [leadRecord],
      trigger: ["approval", "workflow", "blueprint"],
    };

    // 3. Create lead in Zoho CRM
    const crmUrl = `${apiDomain.replace(/\/+$/, "")}/crm/v6/Leads`;
    const crmResponse = await fetch(crmUrl, {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(leadPayload),
    });

    const crmData = await crmResponse.json();

    if (!crmResponse.ok) {
      console.error("Zoho CRM Lead creation API error:", crmData);
      return new Response(
        JSON.stringify({
          error: "Failed to create lead in Zoho CRM",
          details: crmData,
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    console.log("Successfully created lead in Zoho CRM:", JSON.stringify(crmData));
    return new Response(
      JSON.stringify({
        success: true,
        message: "Lead successfully synchronized to Zoho CRM",
        result: crmData,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Unexpected error in Zoho CRM submission-created function:", error);
    return new Response(
      JSON.stringify({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};

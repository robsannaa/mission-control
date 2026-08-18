import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api-route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const GET = withRoute({ name: "/api/integrations/guide" }, async () => {
  return NextResponse.json({
    generatedAt: Date.now(),
    title: "Google setup guide",
    sections: [
      {
        id: "choose-access",
        title: "Choose an access level",
        items: [
          "Read Only means the assistant can look things up, but cannot send or change anything.",
          "Read + Draft means the assistant can prepare replies or event drafts for your approval.",
          "Read + Write means the assistant can read and complete the actions you explicitly allow.",
        ],
      },
      {
        id: "connect",
        title: "Connect Google in the browser",
        items: [
          "Enter your Google email address and click Start Browser-Safe Connect.",
          "Sign in to Google in the new tab and approve the requested access.",
          "After Google redirects you, copy the entire final URL from the browser address bar.",
          "Paste that final URL back into Mission Control and click Finish Connection.",
        ],
      },
      {
        id: "approval",
        title: "How approvals work",
        items: [
          "Denied blocks that action entirely for the selected agent.",
          "Requires Approval places the action in the approval queue before anything is sent or changed.",
          "Allowed lets the selected agent perform that action automatically.",
        ],
      },
      {
        id: "troubleshooting",
        title: "Common fixes",
        items: [
          "If connection fails, try again and make sure you paste the full final redirect URL.",
          "If Gmail or Calendar actions are unavailable, click Check Access.",
          "If sending is blocked, confirm that the account is not still set to Read Only.",
          "If Gmail watch setup fails, confirm the Google Cloud project ID and webhook fields.",
        ],
      },
    ],
  });
});

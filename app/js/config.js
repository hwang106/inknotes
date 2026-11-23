// The Application (client) ID from the app registration on your personal Microsoft account
// (Microsoft Entra admin center → App registrations → InkNotes → Overview).
// It isn't a secret: it only names the app on Microsoft's sign-in page.
// Leave empty to hide OneDrive sync.
export const CLIENT_ID = "";

// Microsoft endpoints (the local test server swaps these for a pretend Microsoft).
export const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
export const GRAPH = "https://graph.microsoft.com/v1.0";

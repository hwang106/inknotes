// The Application (client) ID from the app registration on your personal Microsoft account
// (Microsoft Entra admin center → App registrations → InkNotes → Overview).
// It isn't a secret: it only names the app on Microsoft's sign-in page.
// Set it to "" to hide OneDrive sync.
export const CLIENT_ID = "3d80ff57-85bd-4c83-a2b4-eb486e9bf728";

// Microsoft endpoints (the local test server swaps these for a pretend Microsoft).
export const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
export const GRAPH = "https://graph.microsoft.com/v1.0";

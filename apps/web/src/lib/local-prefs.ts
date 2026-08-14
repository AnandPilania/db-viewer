const LAST_CONNECTION_KEY = "db-viewer:last-connection-id";

export const localPrefs = {
  getLastConnectionId(): string | null {
    return localStorage.getItem(LAST_CONNECTION_KEY);
  },
  setLastConnectionId(id: string | null) {
    if (id) localStorage.setItem(LAST_CONNECTION_KEY, id);
    else localStorage.removeItem(LAST_CONNECTION_KEY);
  },
};

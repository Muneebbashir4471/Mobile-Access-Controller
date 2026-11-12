import { createContext, useContext } from "react";
import type { Me } from "./types";

export const AuthContext = createContext<{ me: Me; setMe: (me: Me) => void; signOut: () => void } | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthContext");
  return ctx;
}

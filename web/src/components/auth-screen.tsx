import { useState, type FormEvent } from "react";
import { Bot, LoaderCircle, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, setToken } from "@/lib/api";
import type { SetupState, User } from "@/lib/types";

type Props = {
  setup: SetupState;
  onAuthenticated: (user: User) => void;
};

export function AuthScreen({ setup, onAuthenticated }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (username.trim().length < 3) {
      setError("Username must be at least 3 characters.");
      return;
    }
    if (!password) {
      setError("Password is required.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const session = setup.needsSetup
        ? await api.createAdmin(username, password)
        : await api.login(username, password);
      setToken(session.token);
      onAuthenticated(session.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to continue");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative grid h-full place-items-center overflow-hidden bg-background p-6">
      <section className="relative grid w-full max-w-[410px] gap-5 rounded-2xl border border-border/90 bg-card/92 p-6 shadow-2xl backdrop-blur-xl">
        <header className="grid gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary"><Bot className="size-5" /></div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{setup.needsSetup ? "Create your workspace" : "Welcome back"}</h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {setup.needsSetup ? "The first account becomes the administrator for this Boosted installation." : "Sign in to your shared agent workspace."}
            </p>
          </div>
        </header>

        <form className="grid gap-3" onSubmit={submit} noValidate>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Username
            <Input autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} required />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Password
            <Input type="password" autoComplete={setup.needsSetup ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {error && <p className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
          <Button className="mt-1 w-full" disabled={busy}>
            {busy && <LoaderCircle className="animate-spin" />}
            {setup.needsSetup ? "Create administrator" : "Sign in"}
          </Button>
        </form>

        {setup.needsSetup && (
          <div className="grid gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
            <div className="flex gap-2"><Users className="mt-0.5 size-3.5 shrink-0" /><span>You can create member accounts after setup. Projects and tasks are shared.</span></div>
            <div className="flex gap-2"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-warning" /><span>Agents and terminals have host access. Only add people you trust.</span></div>
          </div>
        )}
      </section>
    </main>
  );
}

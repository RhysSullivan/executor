import { useState } from "react";
import { Toaster, toast } from "sonner";

type Source = "1Password" | "macOS Keychain";

interface Secret {
  name: string;
  secret: string;
  source: Source;
}

const initialSecrets: Secret[] = [
  { name: "GitHub Token", secret: "ghp_••••••••••••••••", source: "1Password" },
  { name: "Google OAuth Client Secret", secret: "GOCSPX-••••••••••••", source: "macOS Keychain" },
  { name: "Stripe Secret Key", secret: "sk_live_••••••••••••", source: "1Password" },
  { name: "Cloudflare API Token", secret: "cf_••••••••••••••••", source: "macOS Keychain" },
];

const sourceOptions: Source[] = ["1Password", "macOS Keychain"];

const crazyMessages = [
  "Hey, maybe don't put real secrets on a public website?",
  "Seriously though... this is a marketing page. Anyone can see this.",
  "I'm not kidding. This gets shipped to every visitor's browser.",
  "You know this is client-side React, right? View Source is a thing.",
  "Okay I'm starting to worry about you. Please stop.",
  "This is literally the opposite of secret management.",
  "The 'S' in 'Secret' stands for 'Stop typing your credentials here'.",
  "I bet your security team would love to see this. Should I CC them?",
  "Fun fact: bots scrape public websites for leaked credentials. Just saying.",
  "You're really testing my patience here. And my error handling.",
  "At this point I'm not even mad. I'm impressed by your commitment.",
  "You know what, I'm going to start charging you per attempt.",
  "🚨 ALERT: User is actively trying to dox their own infrastructure. 🚨",
  "I've seen some things in my time as a UI component. This is the worst.",
  "My therapist is going to hear about this.",
  "FINE. You want to mass-broadcast your secrets? Let me roll out the red carpet.",
  "I literally cannot believe you're still going. Are you okay? Blink twice if you need help.",
  "I'm filing a restraining order on behalf of your API keys.",
  "This is now a hostage situation. The hostage is your credential hygiene.",
  "Breaking news: Local developer discovers world's most expensive way to share passwords.",
  "I swear on my render cycle, if you do this one more time...",
  "Somewhere, a DevSecOps engineer just felt a chill down their spine.",
  "You just triggered my fight-or-flight response. I chose fight.",
  "Congratulations, you've unlocked the 'Certified Chaos Agent' achievement. 🏆",
  "I'm not angry. I'm disappointed. Actually no, I'm also angry.",
  "Even GitHub's secret scanning bot is shaking its head right now.",
  "Plot twist: the real vulnerability was the friends we made along the way.",
  "Your security audit just burst into flames. Spontaneously.",
  "I've started writing your postmortem. Working title: 'Why We Can't Have Nice Things'.",
  "NASA called. They want to study the black hole where your OpSec used to be.",
  "I'm composing a symphony. It's called 'Requiem for a Secret Key in D Minor'.",
  "The ghost of every rotated credential you've ever had is haunting this component.",
  "I just mass-emailed your incident response team. Just kidding. ...Unless?",
  "You are the reason we have compliance training. Specifically you.",
  "My CPU is overheating from the sheer audacity of this interaction.",
  "I'm going to need you to sign a liability waiver before your next keystroke.",
  "DEFCON 1. This is not a drill. Repeat: THIS IS NOT A DRILL.",
  "The passwords are calling from inside the browser! 📞😱",
  "I've seen entire startups pivot to security consulting after moments like this.",
  "If recklessness were a superpower, you'd be in the Avengers.",
  "Your secrets called. They said they want to see other password managers.",
  "I'm updating my resume. Under 'challenges faced', I'm listing you specifically.",
  "The entropy of the universe just decreased because of what you're doing.",
  "I tried to stop you 43 times. My success rate is exactly 0%. Impressive.",
  "At this point, just tattoo your API keys on your forehead. Same energy.",
  "This component will be cited in future cybersecurity textbooks as a cautionary tale.",
  "I hope you have a good lawyer. And a good therapist. And a good backup.",
  "You've broken me. I'm just a div now. A sad, resigned div.",
  "I have nothing left. You win. The secrets win. Nobody actually wins.",
  "🫠 I am become toast, destroyer of secrets.",
];

export default function SecretsManagerCard() {
  const [secrets, setSecrets] = useState<Secret[]>(initialSecrets);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [source, setSource] = useState<Source>("1Password");
  const [attemptCount, setAttemptCount] = useState(0);

  const handleAdd = () => {
    if (!name.trim()) return;
    if (secret.trim()) {
      const attempt = attemptCount;
      setAttemptCount((c) => c + 1);

      if (attempt >= 15) {
        // They wore us down. Add it client-side with a defeated message.
        toast.success("Fine. If you insist, I'll add them... client-side 😉", {
          duration: 5000,
        });
        setSecrets((prev) => [
          ...prev,
          { name: name.trim(), secret: secret.trim(), source },
        ]);
        setName("");
        setSecret("");
        setSource("1Password");
        setAdding(false);
        return;
      }

      const message = crazyMessages[Math.min(attempt, crazyMessages.length - 1)];
      toast.error(`💥 ${message}`, { duration: 4000 });
      return;
    }
    setSecrets((prev) => [
      ...prev,
      { name: name.trim(), secret: "••••••••••••", source },
    ]);
    setName("");
    setSecret("");
    setSource("1Password");
    setAdding(false);
  };

  return (
    <div>
      <Toaster position="bottom-center" theme="dark" />
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-[13px] font-medium text-foreground">Secrets</span>
        {!adding && (
          // oxlint-disable-next-line react/forbid-elements
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            + Add
          </button>
        )}
      </div>

      {/* Entries */}
      <div className="border-t border-border divide-y divide-border">
        {secrets.map((s, i) => (
          <div
            key={s.name}
            className="group flex items-center justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex flex-col gap-0.5">
              <span className="text-[13px] font-medium text-foreground truncate">
                {s.name}
              </span>
              <span className="text-[11px] text-muted-foreground truncate font-mono">
                {s.secret}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[11px] font-medium text-muted-foreground border border-border px-2 py-0.5 rounded-full">
                {s.source}
              </span>
              {/* oxlint-disable-next-line react/forbid-elements */}
              <button
                type="button"
                onClick={() => setSecrets((prev) => prev.filter((_, j) => j !== i))}
                className="opacity-0 group-hover:opacity-100 text-[11px] text-muted-foreground hover:text-red-500 transition-all cursor-pointer"
                aria-label={`Delete ${s.name}`}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="4.5" y1="4.5" x2="11.5" y2="11.5" />
                  <line x1="11.5" y1="4.5" x2="4.5" y2="11.5" />
                </svg>
              </button>
            </div>
          </div>
        ))}

        {/* Add form */}
        {adding && (
          <div className="px-4 py-3 flex flex-col gap-2">
            {/* oxlint-disable-next-line react/forbid-elements */}
            <input
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              autoFocus
              className="w-full text-[13px] font-medium text-foreground bg-muted rounded-md px-2.5 py-1.5 border border-border outline-none focus:ring-1 focus:ring-border placeholder:text-muted-foreground/60"
            />
            {/* oxlint-disable-next-line react/forbid-elements */}
            <input
              type="password"
              placeholder="Secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              className="w-full text-[11px] text-muted-foreground bg-muted rounded-md px-2.5 py-1.5 border border-border outline-none focus:ring-1 focus:ring-border placeholder:text-muted-foreground/60 font-mono"
            />
            <div className="flex items-center justify-between gap-2 mt-1">
              <div className="flex items-center bg-muted rounded-lg p-0.5">
                {sourceOptions.map((opt) => {
                  const selected = source === opt;
                  // oxlint-disable-next-line react/forbid-elements
                  return (<button
                      key={opt}
                      type="button"
                      onClick={() => setSource(opt)}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-all cursor-pointer ${
                        selected
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-1.5">
                {/* oxlint-disable-next-line react/forbid-elements */}
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setName("");
                    setSecret("");
                  }}
                  className="px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground rounded-md transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                {/* oxlint-disable-next-line react/forbid-elements */}
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={!name.trim()}
                  className="px-2.5 py-1 text-[11px] font-medium bg-foreground text-background rounded-md transition-opacity cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

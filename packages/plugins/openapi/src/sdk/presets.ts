export interface OpenApiPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly url: string;
  readonly icon?: string;
  readonly featured?: boolean;
}

export const openApiPresets: readonly OpenApiPreset[] = [
  {
    id: "stripe",
    name: "Stripe",
    summary: "Payments, subscriptions, customers, and invoices.",
    url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    icon: "https://stripe.com/favicon.ico",
    featured: true,
  },
  {
    id: "github-rest",
    name: "GitHub REST",
    summary: "Repos, issues, pull requests, actions, and users.",
    url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    icon: "https://github.com/favicon.ico",
    featured: true,
  },
  {
    id: "vercel",
    name: "Vercel",
    summary: "Deployments, domains, projects, and edge config.",
    url: "https://openapi.vercel.sh",
    icon: "https://vercel.com/favicon.ico",
    featured: true,
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    summary: "DNS, workers, pages, R2, and security rules.",
    url: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
    icon: "https://cloudflare.com/favicon.ico",
    featured: true,
  },
  {
    id: "neon",
    name: "Neon",
    summary: "Serverless Postgres — projects, branches, and endpoints.",
    url: "https://neon.tech/api_spec/release/v2.json",
    icon: "https://neon.tech/favicon/favicon.ico",
    featured: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    summary: "Models, files, responses, and fine-tuning.",
    url: "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml",
    featured: true,
  },
  {
    id: "asana",
    name: "Asana",
    summary: "Tasks, projects, teams, and workspace management.",
    url: "https://raw.githubusercontent.com/APIs-guru/openapi-directory/main/APIs/asana.com/1.0/openapi.yaml",
    icon: "https://asana.com/favicon.ico",
  },
  {
    id: "twilio",
    name: "Twilio",
    summary: "SMS, voice, video, and messaging APIs.",
    url: "https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json",
    icon: "https://twilio.com/favicon.ico",
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    summary: "Droplets, Kubernetes, databases, and networking.",
    url: "https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml",
    icon: "https://assets.digitalocean.com/favicon.ico",
  },
  {
    id: "petstore",
    name: "Petstore",
    summary: "Classic OpenAPI demo — no auth required.",
    url: "https://petstore3.swagger.io/api/v3/openapi.json",
    icon: "https://petstore3.swagger.io/favicon-32x32.png",
  },
  {
    id: "val-town",
    name: "Val Town",
    summary: "Vals, runs, blobs, and email/web endpoints.",
    url: "https://api.val.town/openapi.json",
    icon: "https://www.val.town/favicon.svg",
  },
  {
    id: "resend",
    name: "Resend",
    summary: "Transactional email sending and domain management.",
    url: "https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml",
    icon: "https://resend.com/static/favicons/favicon.ico",
  },
];

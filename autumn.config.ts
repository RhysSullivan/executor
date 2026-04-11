import { feature, item, plan } from "atmn";

// Features
export const seats = feature({
  id: "seats",
  name: "Seats",
  type: "metered",
  consumable: false,
});

export const executions = feature({
  id: "executions",
  name: "Executions",
  type: "metered",
  consumable: true,
});

export const domainVerification = feature({
  id: "domain-verification",
  name: "Domain Verification",
  type: "boolean",
});

// Plans
export const free = plan({
  id: "free",
  name: "Free",
  autoEnable: true,
  items: [
    item({
      featureId: executions.id,
      included: 5000,
      reset: { interval: "month" },
    }),
  ],
});

export const hobby = plan({
  id: "hobby",
  name: "Hobby",
  price: {
    amount: 10,
    interval: "month",
  },
  items: [
    item({
      featureId: seats.id,
      included: 1,
      price: {
        amount: 10,
        billingUnits: 1,
        billingMethod: "usage_based",
        interval: "month",
      },
    }),
    item({
      featureId: executions.id,
      included: 50000,
      reset: { interval: "month" },
    }),
  ],
});

export const professional = plan({
  id: "professional",
  name: "Professional",
  price: {
    amount: 40,
    interval: "month",
  },
  items: [
    item({
      featureId: seats.id,
      included: 1,
      price: {
        amount: 40,
        billingUnits: 1,
        billingMethod: "usage_based",
        interval: "month",
      },
    }),
    item({
      featureId: executions.id,
      included: 100000,
      reset: { interval: "month" },
    }),
    item({
      featureId: domainVerification.id,
    }),
  ],
});

// Overage add-on
export const executionTopUp = plan({
  id: "execution-top-up",
  name: "Execution Top-Up",
  addOn: true,
  items: [
    item({
      featureId: executions.id,
      price: {
        amount: 1,
        billingUnits: 10000,
        billingMethod: "prepaid",
        interval: "month",
      },
    }),
  ],
});

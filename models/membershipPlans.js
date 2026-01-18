const PLANS = {
  basic: {
    key: 'basic',
    name: 'Basic',
    amount: 0,
    priceLabel: 'Free',
    perks: ['Standard checkout'],
    color: 'outline-primary'
  },
  silver: {
    key: 'silver',
    name: 'Silver',
    amount: 4.99,
    priceLabel: '$4.99 / mo',
    perks: ['Free delivery over $50', '5% off selected items'],
    color: 'primary'
  },
  gold: {
    key: 'gold',
    name: 'Gold',
    amount: 9.99,
    priceLabel: '$9.99 / mo',
    perks: ['Free delivery', '10% off storewide', 'Priority support'],
    color: 'warning'
  }
};

function normalizePlanKey(plan) {
  return String(plan || '').trim().toLowerCase();
}

function getMembershipPlan(planKey) {
  const key = normalizePlanKey(planKey);
  return PLANS[key] ? { ...PLANS[key] } : null;
}

function getMembershipPlans() {
  return {
    basic: { ...PLANS.basic },
    silver: { ...PLANS.silver },
    gold: { ...PLANS.gold }
  };
}

function isPaidPlan(plan) {
  return plan && Number(plan.amount) > 0;
}

module.exports = {
  normalizePlanKey,
  getMembershipPlan,
  getMembershipPlans,
  isPaidPlan
};

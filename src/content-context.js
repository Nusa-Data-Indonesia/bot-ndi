'use strict';

function buildContentContext(context, settings) {
  const knowledge = settings.businessKnowledge;
  const history = (context.history || []).filter((post) => post.status === 'published' && post.pillar === 'ndi');
  const recentCaptions = history
    .filter((post) => typeof post.caption === 'string' && post.caption.trim())
    .sort((a, b) => (Date.parse(b.completedAt || b.scheduledAt || b.createdAt) || 0)
      - (Date.parse(a.completedAt || a.scheduledAt || a.createdAt) || 0))
    .slice(0, 5)
    .map((post) => post.caption);
  const facts = [
    ...knowledge.services.map((name, index) => ({ id: `service-${index + 1}`, kind: 'service', name })),
    { id: 'product-ticketing', kind: 'product', name: 'NDI Ticketing', description: knowledge.ticketing },
    ...knowledge.approvedClaims.map((claim, index) => ({ id: `claim-${index + 1}`, kind: 'approved_claim', claim })),
  ];
  return {
    pillar: 'ndi',
    companyName: knowledge.companyName,
    positioning: knowledge.positioning,
    description: knowledge.description,
    vision: knowledge.vision,
    mission: knowledge.mission,
    primaryAudience: knowledge.primaryAudience,
    secondaryAudience: knowledge.secondaryAudience,
    services: knowledge.services,
    ticketing: knowledge.ticketing,
    contentGuidance: knowledge.contentGuidance,
    approvedClaims: knowledge.approvedClaims,
    forbiddenClaims: knowledge.forbiddenClaims,
    ctaUrl: knowledge.ctaUrl,
    hashtags: settings.hashtags,
    recentCaptions,
    facts,
  };
}

module.exports = { buildContentContext };

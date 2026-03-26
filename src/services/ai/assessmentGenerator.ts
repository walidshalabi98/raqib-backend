import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import { SYSTEM_CONTEXT } from './prompts';

const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });

/**
 * AI Assessment Generator
 * Ingests all project data (indicators, data points, qualitative entries, documents)
 * and generates a comprehensive assessment report automatically.
 */
export async function generateAutoAssessment(
  assessmentId: string,
  projectId: string,
  assessmentType: string
): Promise<void> {
  console.log(`[AssessmentGenerator] Starting auto-assessment for project ${projectId}`);

  // Update status to scoping
  await prisma.assessment.update({
    where: { id: assessmentId },
    data: { status: 'scoping' },
  });

  // 1. Gather ALL project data
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) throw new Error('Project not found');

  const framework = await prisma.framework.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    include: {
      indicators: {
        include: {
          dataPoints: { orderBy: { collectionDate: 'desc' }, take: 20 },
        },
      },
    },
  });

  const qualitativeEntries = await prisma.qualitativeEntry.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  const documents = await prisma.document.findMany({
    where: { projectId, parsingStatus: 'completed' },
    select: { fileName: true, fileType: true, parsedText: true },
  });

  // Update to analysis phase
  await prisma.assessment.update({
    where: { id: assessmentId },
    data: { status: 'analysis' },
  });

  // 2. Build comprehensive context
  const indicators = framework?.indicators || [];
  const indicatorSummary = indicators.map(ind => {
    const trend = ind.dataPoints.length >= 2
      ? (Number(ind.dataPoints[0]?.value) > Number(ind.dataPoints[1]?.value) ? 'improving' : 'declining')
      : 'insufficient_data';
    return {
      text: ind.indicatorText,
      level: ind.level,
      status: ind.status,
      baseline: ind.baselineValue,
      target: ind.targetValue,
      current: ind.currentValue,
      unit: ind.unit,
      trend,
      recentDataPoints: ind.dataPoints.slice(0, 5).map(dp => ({
        value: dp.value,
        date: dp.collectionDate?.toISOString().split('T')[0],
        method: dp.collectionMethod,
        area: dp.geographicArea,
      })),
    };
  });

  const qualSummary = qualitativeEntries.map(e => ({
    type: e.entryType,
    title: e.title,
    themes: e.themes,
    sentiment: e.sentiment,
    content: e.content?.substring(0, 500),
    participants: e.participants,
    location: e.location,
  }));

  const docSummary = documents.map(d => {
    const aiMarker = '---AI_ANALYSIS---';
    const idx = d.parsedText?.indexOf(aiMarker);
    let aiAnalysis = null;
    if (idx && idx > -1) {
      try { aiAnalysis = JSON.parse(d.parsedText!.substring(idx + aiMarker.length).trim()); } catch {}
    }
    return {
      name: d.fileName,
      type: d.fileType,
      summary: aiAnalysis?.summary || d.parsedText?.substring(0, 300),
      keyFindings: aiAnalysis?.keyFindings || [],
    };
  });

  // Status counts
  const statusCounts = {
    on_track: indicators.filter(i => i.status === 'on_track').length,
    at_risk: indicators.filter(i => i.status === 'at_risk').length,
    off_track: indicators.filter(i => i.status === 'off_track').length,
    not_started: indicators.filter(i => i.status === 'not_started').length,
    completed: indicators.filter(i => i.status === 'completed').length,
  };

  const achievementRate = indicators.length > 0
    ? Math.round(((statusCounts.on_track + statusCounts.completed) / indicators.length) * 100)
    : 0;

  // 3. Generate assessment with AI
  const prompt = `You are generating an automated ${assessmentType} assessment for a development project in Palestine.

PROJECT CONTEXT:
- Name: ${project.name}
- Sector: ${project.sector}
- Donor: ${project.donor} (${project.donorType})
- Period: ${project.startDate?.toISOString().split('T')[0]} to ${project.endDate?.toISOString().split('T')[0]}
- Target Beneficiaries: ${project.targetBeneficiaries || 'Not specified'}
- Geographic Scope: ${project.geographicScope || 'Not specified'}
- Budget: $${project.budgetUsd || 0}

INDICATOR PERFORMANCE (${indicators.length} total, ${achievementRate}% achievement rate):
${JSON.stringify(indicatorSummary, null, 2)}

STATUS SUMMARY:
- On Track: ${statusCounts.on_track}
- At Risk: ${statusCounts.at_risk}
- Off Track: ${statusCounts.off_track}
- Completed: ${statusCounts.completed}
- Not Started: ${statusCounts.not_started}

QUALITATIVE DATA (${qualitativeEntries.length} entries):
${JSON.stringify(qualSummary, null, 2)}

DOCUMENT ANALYSIS:
${JSON.stringify(docSummary, null, 2)}

Generate a comprehensive ${assessmentType} assessment report as JSON:
{
  "executiveSummary": "3-4 paragraph executive summary covering overall project performance",
  "methodology": "Description of data sources and methods used in this assessment",
  "keyFindings": [
    {"area": "finding area", "finding": "detailed finding", "evidence": "data supporting this", "rating": "strong|moderate|weak"}
  ],
  "indicatorAnalysis": {
    "overallAchievement": "percentage and narrative",
    "strongPerformers": ["indicator descriptions performing well"],
    "challengeAreas": ["indicators struggling with analysis"],
    "dataGaps": ["areas needing more data"]
  },
  "qualitativeInsights": {
    "mainThemes": ["theme with description"],
    "beneficiaryVoices": "synthesis of qualitative findings",
    "contextualFactors": "factors affecting implementation"
  },
  "recommendations": [
    {"priority": "high|medium|low", "recommendation": "specific actionable recommendation", "timeline": "immediate|short_term|medium_term", "responsible": "who should act"}
  ],
  "lessonsLearned": ["lesson 1", "lesson 2"],
  "riskAssessment": {
    "currentRisks": ["risk with likelihood and impact"],
    "mitigationStrategies": ["strategy for each risk"]
  },
  "nextSteps": ["next step 1", "next step 2"]
}

Return ONLY valid JSON. No markdown. Be specific with data — reference actual indicator values and qualitative findings.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: SYSTEM_CONTEXT,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let report: any;
    try { report = JSON.parse(cleaned); } catch { report = { executiveSummary: text, error: 'Failed to parse structured report' }; }

    // Generate HTML report
    const html = generateAssessmentHtml(project, assessmentType, report, statusCounts, indicators.length);

    // Update to reporting phase, then delivered
    await prisma.assessment.update({
      where: { id: assessmentId },
      data: {
        status: 'delivered',
        deliveredAt: new Date(),
        reportUrl: null, // HTML stored in scope description for now
        scopeDescription: JSON.stringify(report),
      },
    });

    // Also create a Report record with the HTML
    await prisma.report.create({
      data: {
        projectId,
        type: assessmentType === 'baseline' ? 'assessment_report' : assessmentType === 'midterm' ? 'quarterly_summary' : 'assessment_report',
        title: `AI ${assessmentType.charAt(0).toUpperCase() + assessmentType.slice(1)} Assessment — ${project.name}`,
        aiNarrative: html,
        status: 'draft',
      },
    });

    // Create notification
    const admins = await prisma.user.findMany({
      where: { organizationId: project.organizationId, role: { in: ['org_admin', 'platform_admin'] } },
    });
    for (const admin of admins) {
      await prisma.notification.create({
        data: {
          userId: admin.id,
          type: 'assessment_ready',
          title: `Assessment Complete: ${project.name}`,
          message: `AI ${assessmentType} assessment has been generated with ${indicators.length} indicators analyzed.`,
          metadata: { assessmentId, projectId },
        },
      });
    }

    console.log(`[AssessmentGenerator] Assessment complete for ${project.name}`);
  } catch (err: any) {
    console.error('[AssessmentGenerator] Failed:', err.message);
    await prisma.assessment.update({
      where: { id: assessmentId },
      data: { status: 'analysis', scopeDescription: `AI generation failed: ${err.message}` },
    });
  }
}

function generateAssessmentHtml(
  project: any, type: string, report: any, statusCounts: any, totalIndicators: number
): string {
  const achievementRate = totalIndicators > 0
    ? Math.round(((statusCounts.on_track + statusCounts.completed) / totalIndicators) * 100) : 0;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{font-family:'Segoe UI',Arial,sans-serif;margin:40px;color:#1a1a1a;line-height:1.7}
h1{color:#1e3a5f;border-bottom:3px solid #1e3a5f;padding-bottom:10px}
h2{color:#2563eb;margin-top:30px;border-bottom:1px solid #e5e7eb;padding-bottom:5px}
h3{color:#374151;margin-top:20px}
.header{text-align:center;margin-bottom:40px;padding:20px;background:#f8fafc;border-radius:8px}
.metric-row{display:flex;gap:20px;margin:20px 0}
.metric{flex:1;text-align:center;padding:15px;border-radius:8px;border:1px solid #e5e7eb}
.metric .value{font-size:28px;font-weight:bold}
.green{background:#f0fdf4;color:#16a34a} .amber{background:#fffbeb;color:#d97706}
.red{background:#fef2f2;color:#dc2626} .blue{background:#eff6ff;color:#2563eb}
.finding{padding:12px;margin:8px 0;border-left:4px solid #2563eb;background:#f8fafc;border-radius:0 8px 8px 0}
.rec{padding:10px;margin:8px 0;border-radius:8px;border:1px solid #e5e7eb}
.rec.high{border-left:4px solid #ef4444} .rec.medium{border-left:4px solid #f59e0b} .rec.low{border-left:4px solid #3b82f6}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;color:white}
.footer{margin-top:40px;text-align:center;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:20px}
</style></head><body>
<div class="header">
<h1>AI ${type.charAt(0).toUpperCase() + type.slice(1)} Assessment</h1>
<p><strong>Project:</strong> ${project.name} | <strong>Sector:</strong> ${project.sector} | <strong>Donor:</strong> ${project.donor}</p>
<p><strong>Generated:</strong> ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</p>
</div>

<div class="metric-row">
<div class="metric blue"><div class="value">${totalIndicators}</div>Total Indicators</div>
<div class="metric green"><div class="value">${statusCounts.on_track}</div>On Track</div>
<div class="metric amber"><div class="value">${statusCounts.at_risk}</div>At Risk</div>
<div class="metric red"><div class="value">${statusCounts.off_track}</div>Off Track</div>
<div class="metric blue"><div class="value">${achievementRate}%</div>Achievement</div>
</div>

<h2>Executive Summary</h2>
<p>${(report.executiveSummary || '').split('\n').join('</p><p>')}</p>

${report.methodology ? `<h2>Methodology</h2><p>${report.methodology}</p>` : ''}

<h2>Key Findings</h2>
${(report.keyFindings || []).map((f: any) => `
<div class="finding">
<strong>${f.area || 'Finding'}</strong> <span class="badge" style="background:${f.rating === 'strong' ? '#16a34a' : f.rating === 'weak' ? '#dc2626' : '#d97706'}">${f.rating || 'moderate'}</span>
<p>${f.finding || ''}</p>
${f.evidence ? `<p><em>Evidence: ${f.evidence}</em></p>` : ''}
</div>`).join('')}

${report.indicatorAnalysis ? `
<h2>Indicator Analysis</h2>
<p>${report.indicatorAnalysis.overallAchievement || ''}</p>
${report.indicatorAnalysis.strongPerformers?.length ? `<h3>Strong Performers</h3><ul>${report.indicatorAnalysis.strongPerformers.map((s: string) => `<li>${s}</li>`).join('')}</ul>` : ''}
${report.indicatorAnalysis.challengeAreas?.length ? `<h3>Challenge Areas</h3><ul>${report.indicatorAnalysis.challengeAreas.map((s: string) => `<li>${s}</li>`).join('')}</ul>` : ''}
${report.indicatorAnalysis.dataGaps?.length ? `<h3>Data Gaps</h3><ul>${report.indicatorAnalysis.dataGaps.map((s: string) => `<li>${s}</li>`).join('')}</ul>` : ''}
` : ''}

${report.qualitativeInsights ? `
<h2>Qualitative Insights</h2>
${report.qualitativeInsights.mainThemes?.length ? `<h3>Main Themes</h3><ul>${report.qualitativeInsights.mainThemes.map((t: string) => `<li>${t}</li>`).join('')}</ul>` : ''}
${report.qualitativeInsights.beneficiaryVoices ? `<h3>Beneficiary Voices</h3><p>${report.qualitativeInsights.beneficiaryVoices}</p>` : ''}
${report.qualitativeInsights.contextualFactors ? `<h3>Contextual Factors</h3><p>${report.qualitativeInsights.contextualFactors}</p>` : ''}
` : ''}

<h2>Recommendations</h2>
${(report.recommendations || []).map((r: any) => `
<div class="rec ${r.priority || 'medium'}">
<strong>${r.priority?.toUpperCase() || 'MEDIUM'} Priority</strong> — ${r.timeline || 'short_term'}
<p>${r.recommendation || ''}</p>
${r.responsible ? `<p><em>Responsible: ${r.responsible}</em></p>` : ''}
</div>`).join('')}

${report.lessonsLearned?.length ? `
<h2>Lessons Learned</h2>
<ul>${report.lessonsLearned.map((l: string) => `<li>${l}</li>`).join('')}</ul>` : ''}

${report.riskAssessment ? `
<h2>Risk Assessment</h2>
<ul>${(report.riskAssessment.currentRisks || []).map((r: string) => `<li>${r}</li>`).join('')}</ul>
<h3>Mitigation Strategies</h3>
<ul>${(report.riskAssessment.mitigationStrategies || []).map((s: string) => `<li>${s}</li>`).join('')}</ul>` : ''}

${report.nextSteps?.length ? `
<h2>Next Steps</h2>
<ol>${report.nextSteps.map((s: string) => `<li>${s}</li>`).join('')}</ol>` : ''}

<div class="footer">
<p>Generated by RAQIB M&E Platform — Momentum Labs</p>
<p>This assessment was generated using AI analysis of ${totalIndicators} indicators, qualitative data, and project documents.</p>
</div>
</body></html>`;
}

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import { SYSTEM_CONTEXT, writeNarrativePrompt } from './prompts';

const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });

export async function generateReportNarrative(reportId: string, projectId: string): Promise<void> {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw new Error(`Report ${reportId} not found`);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      frameworks: {
        orderBy: { version: 'desc' },
        take: 1,
        include: {
          indicators: {
            include: {
              dataPoints: {
                orderBy: { collectionDate: 'desc' },
                take: 10,
              },
            },
          },
        },
      },
    },
  });
  if (!project) throw new Error(`Project ${projectId} not found`);

  const framework = project.frameworks[0];
  if (!framework) throw new Error('No framework found for project');

  const indicatorData = framework.indicators.map(ind => ({
    indicatorText: ind.indicatorText,
    level: ind.level,
    status: ind.status,
    baselineValue: ind.baselineValue || undefined,
    targetValue: ind.targetValue || undefined,
    currentValue: ind.currentValue || undefined,
    dataPoints: ind.dataPoints.map(dp => ({
      value: dp.value,
      date: dp.collectionDate.toISOString().split('T')[0],
    })),
  }));

  const prompt = writeNarrativePrompt(
    {
      name: project.name,
      sector: project.sector,
      donor: project.donor,
      periodStart: report.periodStart?.toISOString().split('T')[0],
      periodEnd: report.periodEnd?.toISOString().split('T')[0],
    },
    indicatorData,
    report.donorFormat || undefined,
  );

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_CONTEXT,
    messages: [{ role: 'user', content: prompt }],
  });

  const narrative = response.content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('');

  // Generate HTML report
  const html = generateReportHtml(project.name, report.title, narrative, indicatorData);

  // Generate PDF using Puppeteer
  let pdfUrl: string | undefined;
  try {
    pdfUrl = await generatePdf(html, reportId);
  } catch (error) {
    console.warn('[ReportNarrative] PDF generation failed, saving narrative only:', error);
  }

  await prisma.report.update({
    where: { id: reportId },
    data: {
      aiNarrative: narrative,
      fileUrl: pdfUrl,
      status: 'draft',
    },
  });

  console.log(`[ReportNarrative] Report generated for ${project.name}`);
}

function generateReportHtml(
  projectName: string,
  reportTitle: string,
  narrative: string,
  indicators: Array<{
    indicatorText: string;
    level: string;
    status: string;
    baselineValue?: string;
    targetValue?: string;
    currentValue?: string;
  }>,
): string {
  const statusColor: Record<string, string> = {
    on_track: '#22c55e',
    at_risk: '#f59e0b',
    off_track: '#ef4444',
    not_started: '#9ca3af',
    completed: '#3b82f6',
  };

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 40px; color: #1a1a1a; line-height: 1.6; }
    h1 { color: #1e3a5f; border-bottom: 3px solid #1e3a5f; padding-bottom: 10px; }
    h2 { color: #2563eb; margin-top: 30px; }
    .header { text-align: center; margin-bottom: 40px; }
    .narrative { margin: 20px 0; text-align: justify; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #1e3a5f; color: white; padding: 10px; text-align: left; }
    td { padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
    tr:nth-child(even) { background: #f9fafb; }
    .status { padding: 2px 8px; border-radius: 4px; color: white; font-size: 12px; }
    .footer { margin-top: 40px; text-align: center; color: #6b7280; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${reportTitle}</h1>
    <p><strong>Project:</strong> ${projectName}</p>
    <p><strong>Generated:</strong> ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
  </div>

  <h2>Executive Narrative</h2>
  <div class="narrative">${narrative.split('\n').map(p => `<p>${p}</p>`).join('')}</div>

  <h2>Indicator Summary</h2>
  <table>
    <thead>
      <tr><th>Indicator</th><th>Level</th><th>Baseline</th><th>Target</th><th>Current</th><th>Status</th></tr>
    </thead>
    <tbody>
      ${indicators.map(ind => `
        <tr>
          <td>${ind.indicatorText}</td>
          <td>${ind.level}</td>
          <td>${ind.baselineValue || 'N/A'}</td>
          <td>${ind.targetValue || 'N/A'}</td>
          <td>${ind.currentValue || 'N/A'}</td>
          <td><span class="status" style="background:${statusColor[ind.status] || '#9ca3af'}">${ind.status.replace('_', ' ')}</span></td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <div class="footer">
    <p>Generated by RAQIB M&E Platform — Momentum Labs</p>
  </div>
</body>
</html>`;
}

async function generatePdf(html: string, reportId: string): Promise<string> {
  const fs = await import('fs');
  const path = await import('path');
  const puppeteer = await import('puppeteer');

  const reportsDir = path.join(process.cwd(), 'uploads', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const pdfPath = path.join(reportsDir, `${reportId}.pdf`);
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    printBackground: true,
  });

  await browser.close();
  return `/uploads/reports/${reportId}.pdf`;
}

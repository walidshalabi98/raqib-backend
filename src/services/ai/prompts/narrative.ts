export function writeNarrativePrompt(
  projectInfo: { name: string; sector: string; donor: string; periodStart?: string; periodEnd?: string },
  indicators: Array<{
    indicatorText: string;
    level: string;
    status: string;
    baselineValue?: string;
    targetValue?: string;
    currentValue?: string;
    dataPoints: Array<{ value: string; date: string }>;
  }>,
  donorFormat?: string,
): string {
  return `Write a professional M&E narrative report for the following project data.

PROJECT: ${projectInfo.name}
SECTOR: ${projectInfo.sector}
DONOR: ${projectInfo.donor}
${projectInfo.periodStart ? `PERIOD: ${projectInfo.periodStart} to ${projectInfo.periodEnd}` : ''}
${donorFormat ? `DONOR FORMAT: Follow ${donorFormat} reporting guidelines` : ''}

INDICATOR DATA:
${indicators.map(ind => `
[${ind.level.toUpperCase()}] ${ind.indicatorText}
  Status: ${ind.status}
  Baseline: ${ind.baselineValue || 'N/A'} | Target: ${ind.targetValue || 'N/A'} | Current: ${ind.currentValue || 'N/A'}
  Recent data: ${ind.dataPoints.map(dp => `${dp.value} (${dp.date})`).join(', ') || 'No data'}
`).join('')}

Write a 500-800 word narrative that:
1. Opens with an executive summary of overall progress
2. Discusses achievements and progress against targets
3. Highlights any indicators that are off-track or at-risk with analysis
4. Notes geographic or demographic patterns if available
5. Provides recommendations for the next reporting period
6. Uses professional M&E language appropriate for ${projectInfo.donor}

The narrative should be data-driven, referencing specific indicator values and trends.`;
}

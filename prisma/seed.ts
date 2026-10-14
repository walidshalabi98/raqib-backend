import { CollectionMethod, IndicatorLevel, Prisma, PrismaClient } from '@prisma/client';
import { seedLibrary } from '../src/services/library/seed';
import { hashPassword, unusablePasswordHash } from '../src/services/auth/passwords';
import { SEED_ACCOUNTS, SEED_ORGANISATION_NAME, SeedPasswordPlan, seedPasswordPlan } from './seedAccounts';

const prisma = new PrismaClient();

const nodeEnv = process.env.NODE_ENV || 'development';

// This seed DELETES all data before inserting demo records. Never run it in production. Outside local
// development SEED_PASSWORD is required: it becomes the org admin's password only, and must meet the password
// policy (prisma/seedAccounts.ts).
const plan = seedPasswordPlan(nodeEnv, process.env.SEED_PASSWORD);
if (plan.kind === 'refuse') {
  console.error(`Refusing to seed: ${plan.reason}`);
  process.exit(1);
}
const passwordPlan: Exclude<SeedPasswordPlan, { kind: 'refuse' }> = plan;

/**
 * Sample history: the model recorded on the seeded AI-generated frameworks and indicators, which stand for
 * generations made in the past with earlier prompt versions (framework-v1, framework-v3). A new generation
 * records the model that served it (AI_MODEL_MAIN by default). The seed does not read the AI configuration,
 * so it runs with only DATABASE_URL set (as in the migration rehearsal).
 */
const SEED_AI_MODEL = 'claude-sonnet-4-20250514';

const RESULT_LEVELS: IndicatorLevel[] = ['impact', 'outcome', 'output', 'activity'];

/** A result and its children; the depth gives the level (goal → outcomes → outputs → activities). */
interface ResultSpec {
  code: string;
  text: string;
  textAr: string;
  children?: ResultSpec[];
}

/**
 * Creates a framework's results chain, parents first, so the hierarchy rule holds
 * (each parent is exactly one level up). Returns the node ids by code.
 */
async function createResultsChain(frameworkId: string, goal: ResultSpec): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const create = async (spec: ResultSpec, depth: number, parentId: string | null, sortOrder: number): Promise<void> => {
    const node = await prisma.resultNode.create({
      data: { frameworkId, parentId, level: RESULT_LEVELS[depth], code: spec.code, text: spec.text, textAr: spec.textAr, sortOrder },
    });
    ids[spec.code] = node.id;
    for (const [i, child] of (spec.children ?? []).entries()) await create(child, depth + 1, node.id, i);
  };
  await create(goal, 0, null, 0);
  return ids;
}

/**
 * Splits a count into categories by share. The last category takes the remainder,
 * so the parts always add up to the total (the API rejects count breakdowns that do not).
 */
function splitCount(total: number, shares: Record<string, number>): Record<string, number> {
  const entries = Object.entries(shares);
  const parts: Record<string, number> = {};
  let assigned = 0;
  entries.forEach(([category, share], i) => {
    const n = i === entries.length - 1 ? total - assigned : Math.min(total - assigned, Math.round(total * share));
    parts[category] = n;
    assigned += n;
  });
  return parts;
}

const PERCENT_FORMULA = 'numerator ÷ denominator × 100';

/** Seeded indicator: the indicator fields plus the library entry it is adapted from (linked once the library is loaded). */
type SeedIndicator = Omit<Prisma.IndicatorUncheckedCreateInput, 'frameworkId' | 'sortOrder' | 'libraryId'> & {
  libraryId?: string;
};

async function main() {
  console.log('🌱 Seeding RAQIB database...');

  // Clean existing data
  await prisma.notification.deleteMany();
  await prisma.webhookToken.deleteMany();
  await prisma.beneficiaryService.deleteMany();
  await prisma.beneficiary.deleteMany();
  await prisma.dataPoint.deleteMany();
  await prisma.qualitativeEntry.deleteMany();
  await prisma.indicator.deleteMany();
  // Results reference their parent (ON DELETE RESTRICT): unlink them before deleting.
  await prisma.resultNode.updateMany({ data: { parentId: null } });
  await prisma.resultNode.deleteMany();
  await prisma.framework.deleteMany();
  await prisma.assessment.deleteMany();
  await prisma.document.deleteMany();
  await prisma.report.deleteMany();
  await prisma.mETemplate.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
  await prisma.project.deleteMany();
  await prisma.organization.deleteMany();
  // IndicatorLibraryEntry rows are kept: the library is loaded with an idempotent upsert at the end.

  // Organization
  const org = await prisma.organization.create({
    data: {
      name: SEED_ORGANISATION_NAME,
      nameAr: 'مومنتوم لابز',
      type: 'local_ngo',
      country: 'Palestine',
      city: 'Ramallah',
      contactEmail: 'info@momentumlabs.ps',
      contactPhone: '+970-2-123-4567',
      subscriptionStatus: 'active',
    },
  });

  // Users. With SEED_PASSWORD only the org admin can sign in; each of the other accounts gets its own random
  // password nobody knows, until the admin resets it in Settings (a one-time temporary password).
  const adminHash = await hashPassword(passwordPlan.password);
  const otherHash = () => (passwordPlan.kind === 'sharedDemo' ? hashPassword(passwordPlan.password) : unusablePasswordHash());

  const adminUser = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: SEED_ACCOUNTS.admin,
      passwordHash: adminHash,
      fullName: 'Walid Shalabi',
      fullNameAr: 'وليد شلبي',
      role: 'org_admin',
      languagePref: 'en',
    },
  });

  const meOfficer = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: SEED_ACCOUNTS.officer,
      passwordHash: await otherHash(),
      fullName: 'Sara Ahmad',
      fullNameAr: 'سارة أحمد',
      role: 'me_officer',
      languagePref: 'en',
    },
  });

  await prisma.user.create({
    data: {
      organizationId: org.id,
      email: SEED_ACCOUNTS.donor,
      passwordHash: await otherHash(),
      fullName: 'John Smith',
      role: 'donor_viewer',
      languagePref: 'en',
    },
  });

  // Projects
  const project1 = await prisma.project.create({
    data: {
      organizationId: org.id,
      name: 'Youth Employment & Skills Development',
      nameAr: 'تشغيل الشباب وتنمية المهارات',
      description: 'A comprehensive program to improve employment prospects for Palestinian youth aged 18-30 through vocational training, internships, and entrepreneurship support.',
      sector: 'livelihoods',
      sectors: ['livelihoods', 'youth', 'gender'],
      humanitarian: false,
      donor: 'GIZ',
      donorType: 'giz',
      budgetUsd: 450000,
      startDate: new Date('2025-01-01'),
      endDate: new Date('2027-12-31'),
      targetBeneficiaries: 2500,
      geographicScope: 'West Bank - Ramallah, Nablus, Hebron',
      status: 'active',
    },
  });

  const project2 = await prisma.project.create({
    data: {
      organizationId: org.id,
      name: 'Community Health Resilience Program',
      nameAr: 'برنامج مرونة الصحة المجتمعية',
      description: 'Strengthening primary healthcare access and community health resilience in underserved areas of the West Bank.',
      sector: 'health',
      sectors: ['health', 'mhpss'],
      humanitarian: false,
      donor: 'EU',
      donorType: 'eu',
      budgetUsd: 320000,
      startDate: new Date('2025-03-01'),
      endDate: new Date('2027-02-28'),
      targetBeneficiaries: 5000,
      geographicScope: 'West Bank - Area C communities',
      status: 'active',
    },
  });

  const project3 = await prisma.project.create({
    data: {
      organizationId: org.id,
      name: 'Education Quality Enhancement',
      nameAr: 'تحسين جودة التعليم',
      description: 'Improving education quality in marginalized schools through teacher training, curriculum development, and digital learning tools.',
      sector: 'education',
      // Includes Gaza schools: an education-in-emergencies response with psychosocial support.
      sectors: ['education', 'mhpss', 'protection'],
      humanitarian: true,
      donor: 'UNICEF',
      donorType: 'unicef',
      budgetUsd: 280000,
      startDate: new Date('2025-06-01'),
      endDate: new Date('2026-12-31'),
      targetBeneficiaries: 3200,
      geographicScope: 'West Bank and Gaza',
      status: 'setup',
    },
  });

  // A humanitarian DG ECHO project without a framework yet (try framework generation here).
  const project4 = await prisma.project.create({
    data: {
      organizationId: org.id,
      name: 'Gaza Emergency WASH and Cash Response',
      nameAr: 'الاستجابة الطارئة في مجالي المياه والصرف الصحي والمساعدات النقدية في غزة',
      description: 'Emergency water trucking, hygiene kits and multipurpose cash assistance for displaced and host-community households in the southern Gaza Strip.',
      sector: 'wash',
      sectors: ['wash', 'cash', 'shelter'],
      humanitarian: true,
      donor: 'DG ECHO',
      donorType: 'echo',
      budgetUsd: 600000,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
      targetBeneficiaries: 12000,
      geographicScope: 'Gaza Strip - Khan Younis, Deir al-Balah',
      status: 'setup',
    },
  });

  // Indicators adapted from the library are linked once the library is loaded (at the end).
  const libraryLinks: Array<{ indicatorId: string; libraryId: string }> = [];
  const createIndicators = async (frameworkId: string, specs: SeedIndicator[]) => {
    const created = [];
    for (const [sortOrder, { libraryId, ...data }] of specs.entries()) {
      const indicator = await prisma.indicator.create({ data: { ...data, frameworkId, sortOrder } });
      if (libraryId) libraryLinks.push({ indicatorId: indicator.id, libraryId });
      created.push(indicator);
    }
    return created;
  };

  // Framework for Project 1 (generated by the earlier framework prompts, reviewed and approved)
  const framework1 = await prisma.framework.create({
    data: {
      projectId: project1.id,
      version: 1,
      status: 'approved',
      aiModelUsed: SEED_AI_MODEL,
      approvedAt: new Date('2025-02-15'),
      approvedBy: adminUser.id,
    },
  });

  const results1 = await createResultsChain(framework1.id, {
    code: 'G',
    text: 'Improved economic participation of young women and men (18–30) in Ramallah, Nablus and Hebron governorates',
    textAr: 'تحسين المشاركة الاقتصادية للشابات والشباب (18–30 عامًا) في محافظات رام الله ونابلس والخليل',
    children: [
      {
        code: 'O1',
        text: 'Young women and men who complete the programme secure decent employment',
        textAr: 'حصول الشابات والشباب الذين يُتمّون البرنامج على عمل لائق',
        children: [
          {
            code: 'O1.1',
            text: 'Young women and men complete market-relevant vocational training',
            textAr: 'إتمام الشابات والشباب تدريبًا مهنيًا يلائم احتياجات سوق العمل',
            children: [
              { code: 'A1.1.1', text: 'Deliver vocational training courses with accredited training centres', textAr: 'تنفيذ دورات التدريب المهني بالشراكة مع مراكز تدريب معتمدة' },
              { code: 'A1.1.2', text: 'Run outreach and transport support for young women', textAr: 'تنفيذ أنشطة التواصل وتوفير دعم المواصلات للشابات' },
            ],
          },
          {
            code: 'O1.2',
            text: 'Graduates are placed in internships with private-sector employers',
            textAr: 'إلحاق الخريجين ببرامج تدريب عملي لدى مشغّلين من القطاع الخاص',
            children: [
              { code: 'A1.2.1', text: 'Match graduates with partner employers', textAr: 'مواءمة الخريجين مع المشغّلين الشركاء' },
              { code: 'A1.2.2', text: 'Monitor internship placements', textAr: 'متابعة برامج التدريب العملي' },
            ],
          },
        ],
      },
      {
        code: 'O2',
        text: 'Young entrepreneurs start and sustain small businesses',
        textAr: 'تأسيس رواد الأعمال الشباب مشاريع صغيرة والحفاظ على استمراريتها',
        children: [
          {
            code: 'O2.1',
            text: 'Young entrepreneurs receive small business grants and coaching',
            textAr: 'حصول رواد الأعمال الشباب على منح للمشاريع الصغيرة وعلى الإرشاد',
            children: [
              { code: 'A2.1.1', text: 'Run entrepreneurship bootcamps', textAr: 'تنفيذ معسكرات تدريبية في ريادة الأعمال' },
              { code: 'A2.1.2', text: 'Select grantees through a scoring committee', textAr: 'اختيار المستفيدين من المنح عبر لجنة تقييم' },
            ],
          },
        ],
      },
    ],
  });

  // Indicators for Project 1, with their reference sheets (knowledge/me-foundations.md §3)
  const aiFramework1 = { provenance: 'ai_generated' as const, aiModel: SEED_AI_MODEL, promptVersion: 'framework-v1' };
  // Indicators without seeded data points (women's share, sessions, businesses operating) are not named.
  const [employmentRate, graduatesEmployed, completedTraining, , , internships, grants] =
    await createIndicators(framework1.id, [
      {
        resultId: results1.G,
        indicatorText: 'Employment rate of young women and men (18–30) in target governorates',
        indicatorTextAr: 'معدل التشغيل بين الشابات والشباب (18–30 عامًا) في المحافظات المستهدفة',
        level: 'impact',
        dataCollectionMethod: 'hh_survey',
        frequency: 'annual',
        unit: 'percent',
        baselineValue: '22',
        targetValue: '35',
        currentValue: '26',
        status: 'on_track',
        phases: ['baseline', 'midterm', 'endline'],
        definition: 'Persons aged 18–30 in the target governorates who worked at least one hour for pay or profit in the reference week (ILO definition), as a share of all persons aged 18–30 living there (employment-to-population ratio).',
        calculation: {
          numerator: 'Persons aged 18–30 in the target governorates employed in the reference week',
          denominator: 'All persons aged 18–30 in the target governorates',
          formula: PERCENT_FORMULA,
          rounding: 'Whole number',
        },
        direction: 'increase',
        disaggregation: ['sex', 'age', 'disability', 'location'],
        meansOfVerification: 'Programme household survey using the PCBS Labour Force Survey employment module, n≈400 households representative of the target communities; compared with PCBS governorate figures for the same year',
        baselineDate: new Date('2025-02-28'),
        baselineMethod: 'Baseline household survey, January–February 2025 (n=400 households in the three governorates)',
        targetJustification: 'Proposal target: baseline + 13 percentage points by the end of 2027, in line with comparable employment programmes in the West Bank.',
        intermediateTargets: [{ date: '2025-12-31', value: '26' }, { date: '2026-12-31', value: '30' }, { date: '2027-12-31', value: '35' }],
        assumptions: 'The West Bank labour market does not deteriorate sharply and movement restrictions allow access to workplaces. Many factors beyond the programme affect this rate: the programme contributes to the change but cannot claim it alone.',
        responsibility: 'M&E Officer',
        aiRationale: 'Measures the overall employment impact on young people in the target governorates.',
        isApproved: true,
        ...aiFramework1,
      },
      {
        resultId: results1.O1,
        libraryId: 'LV-01',
        indicatorText: '% of training graduates employed or self-employed six months after completing training',
        indicatorTextAr: 'نسبة خريجي التدريب الذين يعملون بأجر أو لحسابهم الخاص بعد ستة أشهر من إنهاء التدريب',
        level: 'outcome',
        dataCollectionMethod: 'hh_survey',
        frequency: 'per_cohort',
        unit: 'percent',
        baselineValue: '0',
        targetValue: '60',
        currentValue: '45',
        status: 'at_risk',
        phases: ['midterm', 'endline'],
        definition: 'Graduates who report paid employment or self-employment of at least 15 hours a week six months after completing a programme course, as a share of the graduates reached by the tracer survey.',
        calculation: {
          numerator: 'Graduates employed or self-employed (≥15 hours a week) at six months',
          denominator: 'Graduates reached by the six-month tracer survey',
          formula: PERCENT_FORMULA,
          rounding: 'Whole number',
        },
        direction: 'increase',
        disaggregation: ['sex', 'age', 'disability', 'location'],
        meansOfVerification: 'Six-month phone tracer survey of every cohort (all graduates; response rate reported), with employer confirmation for a 10% sample',
        baselineDate: new Date('2025-01-01'),
        baselineMethod: 'No graduates before the programme started (baseline 0 by definition); first measured at the tracer survey of cohort 1 in June 2025',
        targetJustification: 'Proposal target of 60%, above the 35–50% typical for the Palestinian labour market because training is linked to employer demand.',
        intermediateTargets: [{ date: '2025-12-31', value: '45' }, { date: '2026-12-31', value: '55' }, { date: '2027-12-31', value: '60' }],
        assumptions: 'Graduates can be reached by phone; partner employers in the target governorates keep hiring.',
        responsibility: 'M&E Officer',
        aiRationale: 'Measures whether the training leads to actual employment.',
        isApproved: true,
        ...aiFramework1,
      },
      {
        resultId: results1['O1.1'],
        libraryId: 'YO-01',
        indicatorText: 'Number of young women and men who completed vocational training',
        indicatorTextAr: 'عدد الشابات والشباب الذين أتمّوا التدريب المهني',
        level: 'output',
        dataCollectionMethod: 'document_review',
        frequency: 'quarterly',
        unit: 'number',
        baselineValue: '0',
        targetValue: '800',
        currentValue: '342',
        status: 'on_track',
        phases: ['baseline', 'midterm', 'endline'],
        definition: 'Participants aged 18–30 who attended at least 80% of the sessions of a programme vocational course and passed its final assessment. Each person is counted once, even after completing more than one course (cumulative).',
        calculation: { formula: 'Unique participants meeting the completion threshold (cumulative)' },
        direction: 'increase',
        disaggregation: ['sex', 'age', 'disability', 'location'],
        meansOfVerification: 'Attendance sheets, final assessment results and the certificates register kept by the partner training centres',
        baselineDate: new Date('2025-01-01'),
        baselineMethod: 'Programme records at the start (no graduates yet)',
        targetJustification: 'Proposal and budget: 800 trainees in eight cohorts of about 100.',
        intermediateTargets: [{ date: '2025-12-31', value: '350' }, { date: '2026-12-31', value: '600' }, { date: '2027-12-31', value: '800' }],
        assumptions: 'Partner training centres remain accessible; transport costs do not prevent young women from attending.',
        responsibility: 'Field Team',
        provenance: 'library',
        isApproved: true,
      },
      {
        resultId: results1['O1.1'],
        indicatorText: '% of training participants who are women',
        indicatorTextAr: 'نسبة النساء بين المشاركين في التدريب',
        level: 'output',
        dataCollectionMethod: 'document_review',
        frequency: 'quarterly',
        unit: 'percent',
        baselineValue: '30',
        targetValue: '50',
        currentValue: '42',
        status: 'on_track',
        phases: ['baseline', 'midterm', 'endline'],
        definition: 'Women enrolled in programme vocational courses as a share of all enrolled participants (cumulative). The indicator itself is the sex split, so it is not disaggregated by sex again.',
        calculation: {
          numerator: 'Women enrolled in programme vocational courses',
          denominator: 'All participants enrolled in programme vocational courses',
          formula: PERCENT_FORMULA,
          rounding: 'Whole number',
        },
        direction: 'increase',
        disaggregation: ['age', 'disability', 'location'],
        meansOfVerification: 'Enrolment registers of the partner training centres',
        baselineDate: new Date('2024-12-31'),
        baselineMethod: 'Enrolment records of the partner centres for their 2024 courses',
        targetJustification: 'Proposal: gender parity among participants (GIZ gender marker GG1).',
        intermediateTargets: [{ date: '2026-06-30', value: '45' }, { date: '2027-12-31', value: '50' }],
        assumptions: 'Outreach and transport support offset family and mobility barriers for young women.',
        responsibility: 'Project Manager',
        provenance: 'manual',
        isApproved: true,
      },
      {
        resultId: results1['O1.1'],
        indicatorText: 'Number of vocational training sessions delivered',
        indicatorTextAr: 'عدد جلسات التدريب المهني المنفذة',
        level: 'output',
        dataCollectionMethod: 'document_review',
        frequency: 'monthly',
        unit: 'number',
        baselineValue: '0',
        targetValue: '48',
        currentValue: '22',
        status: 'on_track',
        phases: ['baseline', 'midterm', 'endline'],
        definition: 'Training sessions of at least three hours delivered by a partner centre under a programme course (cumulative).',
        calculation: { formula: 'Sum of sessions recorded in the session logs' },
        direction: 'increase',
        disaggregation: ['location'],
        meansOfVerification: 'Session logs signed by the trainer and the centre coordinator, spot-checked monthly by the field team',
        baselineDate: new Date('2025-01-01'),
        baselineMethod: 'Programme records at the start (no sessions yet)',
        targetJustification: 'Training plan in the proposal: six sessions per cohort for eight cohorts.',
        assumptions: 'Closures do not interrupt the training calendar for more than two weeks at a time.',
        responsibility: 'Field Team',
        provenance: 'manual',
        isApproved: true,
      },
      {
        resultId: results1['O1.2'],
        indicatorText: 'Number of internship placements facilitated with private-sector employers',
        indicatorTextAr: 'عدد فرص التدريب العملي التي تم تيسيرها لدى مشغّلين من القطاع الخاص',
        level: 'output',
        dataCollectionMethod: 'document_review',
        frequency: 'monthly',
        unit: 'number',
        baselineValue: '0',
        targetValue: '500',
        currentValue: '187',
        status: 'on_track',
        phases: ['baseline', 'midterm', 'endline'],
        definition: 'Graduates who start a structured internship of at least eight weeks with a private-sector employer under a signed programme agreement. Each graduate is counted once (cumulative).',
        calculation: { formula: 'Unique graduates with a signed internship agreement (cumulative)' },
        direction: 'increase',
        disaggregation: ['sex', 'location'],
        meansOfVerification: 'Signed internship agreements and the placement register, cross-checked with employer attendance confirmations',
        baselineDate: new Date('2025-01-01'),
        baselineMethod: 'Programme records at the start (no placements yet)',
        targetJustification: 'Proposal: about 60% of graduates offered an internship.',
        assumptions: 'Partner employers keep their internship commitments during economic downturns.',
        responsibility: 'Field Team',
        aiRationale: 'Tracks the internship connections the programme facilitates.',
        isApproved: true,
        ...aiFramework1,
      },
      {
        resultId: results1['O2.1'],
        indicatorText: 'Number of small business grants disbursed to young entrepreneurs',
        indicatorTextAr: 'عدد منح المشاريع الصغيرة المصروفة لرواد الأعمال الشباب',
        level: 'output',
        dataCollectionMethod: 'document_review',
        frequency: 'quarterly',
        unit: 'number',
        baselineValue: '0',
        targetValue: '120',
        currentValue: '34',
        status: 'off_track',
        phases: ['baseline', 'midterm', 'endline'],
        definition: 'Grants of up to USD 5,000 whose first instalment was paid to a young entrepreneur (18–30) selected by the grant committee. Each business is counted once (cumulative).',
        calculation: { formula: 'Unique businesses with a first instalment paid (cumulative)' },
        direction: 'increase',
        disaggregation: ['sex', 'age', 'location'],
        meansOfVerification: 'Grant agreements and bank transfer records in the grants register kept by the finance unit',
        baselineDate: new Date('2025-01-01'),
        baselineMethod: 'Programme records at the start (no grants yet)',
        targetJustification: 'Budget line for 120 grants of up to USD 5,000.',
        assumptions: 'Banks can transfer funds to grantees without delays caused by closures.',
        responsibility: 'Project Manager',
        aiRationale: 'Measures delivery of the entrepreneurship support component.',
        isApproved: true,
        ...aiFramework1,
      },
      {
        resultId: results1.O2,
        indicatorText: '% of grant-supported youth businesses operating 12 months after receiving the grant',
        indicatorTextAr: 'نسبة مشاريع الشباب المدعومة بالمنح التي ما زالت تعمل بعد 12 شهرًا من استلام المنحة',
        level: 'outcome',
        dataCollectionMethod: 'kii',
        frequency: 'biannual',
        unit: 'percent',
        targetValue: '70',
        status: 'not_started',
        phases: ['midterm', 'endline'],
        definition: 'Businesses that received a programme grant and are trading (sales in the past month) 12 months after the first instalment, as a share of the businesses that received their first instalment at least 12 months earlier.',
        calculation: {
          numerator: 'Grant-supported businesses trading 12 months after the first instalment',
          denominator: 'Businesses whose first instalment was paid at least 12 months earlier',
          formula: PERCENT_FORMULA,
          rounding: 'Whole number',
        },
        direction: 'increase',
        disaggregation: ['sex', 'location'],
        meansOfVerification: 'Follow-up visit or phone interview with each grantee 12 months after the first instalment, using the business status checklist',
        baselineMethod: 'Pending baseline: first measured in June 2026, 12 months after the first grants',
        targetJustification: 'Proposal target of 70%, consistent with survival rates reported by comparable youth grant schemes in the West Bank.',
        intermediateTargets: [{ date: '2027-12-31', value: '70' }],
        assumptions: 'Market access for small businesses does not deteriorate sharply; grantees remain reachable.',
        responsibility: 'M&E Officer',
        aiRationale: 'Shows whether the grants lead to businesses that last, the change outcome O2 describes.',
        isApproved: true,
        ...aiFramework1,
      },
    ]);

  // Data points. Breakdowns follow the API rules: every dimension of a count adds up to the value;
  // percentage indicators give the rate for each group.
  const sexSplit = (value: number, femaleShare: number) => splitCount(value, { female: femaleShare, male: 1 - femaleShare });
  const countBreakdown = (value: number, femaleShare: number, withDisability?: number) => ({
    sex: sexSplit(value, femaleShare),
    ...(withDisability !== undefined && { disability: splitCount(value, { yes: withDisability, no: 1 - withDisability }) }),
  });
  const percentBySex = (female: number, male: number) => ({ sex: { female, male } });

  type SeedDataPoint = { indicatorId: string; value: number; date: string; method: CollectionMethod; breakdown?: Prisma.InputJsonValue };
  const countSeries = (indicatorId: string, rows: Array<[number, string]>, breakdown: (value: number) => Prisma.InputJsonValue): SeedDataPoint[] =>
    rows.map(([value, date]) => ({ indicatorId, value, date, method: 'document_review', breakdown: breakdown(value) }));

  const dataPointsData: SeedDataPoint[] = [
    { indicatorId: employmentRate.id, value: 22, date: '2025-01-15', method: 'hh_survey', breakdown: percentBySex(8, 36) },
    { indicatorId: employmentRate.id, value: 24, date: '2025-06-15', method: 'hh_survey', breakdown: percentBySex(9, 39) },
    { indicatorId: employmentRate.id, value: 26, date: '2025-12-15', method: 'hh_survey', breakdown: percentBySex(11, 41) },
    ...countSeries(completedTraining.id, [[0, '2025-01-15'], [85, '2025-03-31'], [178, '2025-06-30'], [265, '2025-09-30'], [342, '2025-12-31']],
      value => countBreakdown(value, 0.42, 0.04)),
    { indicatorId: graduatesEmployed.id, value: 0, date: '2025-06-30', method: 'hh_survey' },
    { indicatorId: graduatesEmployed.id, value: 45, date: '2025-12-31', method: 'hh_survey', breakdown: percentBySex(38, 50) },
    ...countSeries(internships.id, [[0, '2025-01-31'], [45, '2025-03-31'], [98, '2025-06-30'], [142, '2025-09-30'], [187, '2025-12-31']],
      value => countBreakdown(value, 0.38)),
    ...countSeries(grants.id, [[0, '2025-03-31'], [12, '2025-06-30'], [22, '2025-09-30'], [34, '2025-12-31']],
      value => countBreakdown(value, 0.35)),
  ];

  for (const [i, dp] of dataPointsData.entries()) {
    await prisma.dataPoint.create({
      data: {
        indicatorId: dp.indicatorId,
        projectId: project1.id,
        value: String(dp.value),
        collectionDate: new Date(dp.date),
        collectionMethod: dp.method,
        dataSource: 'Manual entry',
        geographicArea: ['Ramallah', 'Nablus', 'Hebron'][i % 3],
        ...(dp.breakdown !== undefined && { breakdown: dp.breakdown }),
        createdBy: meOfficer.id,
      },
    });
  }

  // Framework for Project 2: generated with the Phase 2 prompts (framework-v3) and awaiting expert review
  // (indicators are unapproved, so the app labels them "AI suggested — review before approval").
  const framework2 = await prisma.framework.create({
    data: { projectId: project2.id, version: 1, status: 'expert_review', aiModelUsed: SEED_AI_MODEL },
  });

  const results2 = await createResultsChain(framework2.id, {
    code: 'G',
    text: 'Improved health and well-being of communities in underserved Area C localities of the West Bank',
    textAr: 'تحسين صحة ورفاه المجتمعات في التجمعات المحرومة من الخدمات في المنطقة (ج) بالضفة الغربية',
    children: [
      {
        code: 'O1',
        text: 'Women, children and older persons in target communities use quality primary health care services',
        textAr: 'استخدام النساء والأطفال وكبار السن في المجتمعات المستهدفة خدمات رعاية صحية أولية ذات جودة',
        children: [
          {
            code: 'O1.1',
            text: 'Mobile clinics and supported facilities provide primary health care consultations',
            textAr: 'تقديم العيادات المتنقلة والمرافق المدعومة استشارات الرعاية الصحية الأولية',
            children: [
              { code: 'A1.1.1', text: 'Operate weekly mobile clinic visits', textAr: 'تشغيل زيارات أسبوعية للعيادات المتنقلة' },
              { code: 'A1.1.2', text: 'Supply essential medicines to supported facilities', textAr: 'تزويد المرافق المدعومة بالأدوية الأساسية' },
            ],
          },
          {
            code: 'O1.2',
            text: 'People in distress receive focused psychosocial support at supported facilities',
            textAr: 'حصول الأشخاص الذين يعانون من الضيق النفسي على دعم نفسي اجتماعي مركّز في المرافق المدعومة',
            children: [
              { code: 'A1.2.1', text: 'Train facility staff in psychological first aid and referral', textAr: 'تدريب طواقم المرافق على الإسعافات النفسية الأولية والإحالة' },
            ],
          },
        ],
      },
    ],
  });

  const aiFramework2 = { provenance: 'ai_generated' as const, aiModel: SEED_AI_MODEL, promptVersion: 'framework-v3' };
  await createIndicators(framework2.id, [
    {
      resultId: results2.O1,
      libraryId: 'HE-02',
      indicatorText: '% of pregnant women in target communities receiving at least four antenatal care visits',
      indicatorTextAr: 'نسبة النساء الحوامل في المجتمعات المستهدفة اللواتي تلقين أربع زيارات رعاية ما قبل الولادة على الأقل',
      level: 'outcome',
      dataCollectionMethod: 'hh_survey',
      frequency: 'biannual',
      unit: 'percent',
      phases: ['baseline', 'midterm', 'endline'],
      definition: 'Women in the target communities who gave birth in the reference period and attended at least four antenatal care visits during the pregnancy, as a share of all women there who gave birth in the period.',
      calculation: {
        numerator: 'Women who gave birth in the period with at least four antenatal care visits',
        denominator: 'Women in the target communities who gave birth in the period',
        formula: PERCENT_FORMULA,
      },
      direction: 'increase',
      disaggregation: ['age', 'disability', 'location'],
      meansOfVerification: 'Household survey, maternal health module, n≈500 households in the target Area C communities; facility antenatal care registers for the quarterly trend',
      baselineMethod: 'Pending baseline: household survey in the target communities (in the field since April 2025)',
      targetJustification: 'Proposed method: baseline + 15 percentage points, consistent with similar EU-funded primary health care programmes — confirm after baseline.',
      assumptions: 'Mobile clinics can reach the communities despite movement restrictions; align the definition with the Ministry of Health.',
      responsibility: 'M&E Officer',
      aiRationale: 'A widely used coverage indicator for the maternal health part of outcome O1, adapted from library entry HE-02.',
      ...aiFramework2,
    },
    {
      resultId: results2['O1.1'],
      libraryId: 'HE-03',
      indicatorText: 'Number of consultations provided at supported primary health care facilities and mobile clinics',
      indicatorTextAr: 'عدد الاستشارات الطبية المقدّمة في مرافق الرعاية الصحية الأولية المدعومة والعيادات المتنقلة',
      level: 'output',
      dataCollectionMethod: 'document_review',
      frequency: 'monthly',
      unit: 'number',
      phases: ['baseline', 'midterm', 'endline'],
      definition: 'Outpatient consultations recorded at facilities receiving project support and at programme mobile clinics during the period. Counts consultations, not unique patients.',
      calculation: { formula: 'Sum of consultations from facility and mobile clinic registers' },
      direction: 'increase',
      disaggregation: ['sex', 'age', 'location'],
      meansOfVerification: 'Facility HMIS reports and mobile clinic consultation registers, compiled monthly by the health coordinator',
      baselineMethod: 'Facility records for the 12 months before the project start (to be compiled during inception)',
      targetJustification: 'Proposed method: baseline consultation volume from the facility records, raised in line with the number of target people (5,000) and comparable programmes — confirm after baseline.',
      assumptions: 'Supported facilities keep complete registers; mobile clinic schedules are not disrupted by closures.',
      responsibility: 'Field Team',
      aiRationale: 'Counts the main service delivered under output O1.1.',
      ...aiFramework2,
    },
    {
      resultId: results2['O1.2'],
      libraryId: 'PR-01',
      standardReferenceCode: 'IASC MHPSS M&E Framework O5.4',
      indicatorText: 'Number of people receiving focused psychosocial or psychological care',
      indicatorTextAr: 'عدد الأشخاص الذين يتلقّون رعاية نفسية اجتماعية أو نفسية مركّزة',
      level: 'output',
      dataCollectionMethod: 'document_review',
      frequency: 'monthly',
      unit: 'number',
      phases: ['baseline', 'midterm', 'endline'],
      definition: 'Individuals who received at least four sessions of a focused (individual, family or group) psychosocial or psychological intervention at a supported facility.',
      calculation: { formula: 'Unique clients meeting the session threshold' },
      direction: 'increase',
      disaggregation: ['sex', 'age', 'disability', 'location'],
      meansOfVerification: 'Case management records, aggregated monthly by the MHPSS focal point (no personal data leaves the facility)',
      baselineMethod: 'No focused care offered at the supported facilities before the project (to be confirmed during inception)',
      targetJustification: 'Proposed method: set after the baseline from the facility caseload capacity (staff × clients per month) over the project period — confirm after baseline.',
      assumptions: 'Trained staff stay in post; stigma does not prevent people from seeking care.',
      responsibility: 'MHPSS Focal Point',
      aiRationale: 'IASC MHPSS standard output indicator for focused care, matching the MHPSS sector of the project.',
      ...aiFramework2,
    },
  ]);

  // Assessments
  await prisma.assessment.create({
    data: {
      projectId: project1.id,
      type: 'baseline',
      status: 'delivered',
      scopeDescription: 'Baseline assessment covering all three target governorates',
      sampleSize: 400,
      methodsIncluded: ['hh_survey', 'fgd', 'kii'],
      priceUsd: 8500,
      startedAt: new Date('2025-01-10'),
      deliveredAt: new Date('2025-02-28'),
    },
  });

  await prisma.assessment.create({
    data: {
      projectId: project1.id,
      type: 'midterm',
      status: 'scoping',
      scopeDescription: 'Mid-term evaluation of training program effectiveness',
      sampleSize: 300,
      methodsIncluded: ['hh_survey', 'fgd', 'kii', 'observation'],
      priceUsd: 12000,
    },
  });

  await prisma.assessment.create({
    data: {
      projectId: project2.id,
      type: 'baseline',
      status: 'in_field',
      scopeDescription: 'Health baseline covering Area C communities',
      sampleSize: 500,
      methodsIncluded: ['hh_survey', 'kii'],
      priceUsd: 7200,
      startedAt: new Date('2025-04-01'),
    },
  });

  // Qualitative Entries
  await prisma.qualitativeEntry.create({
    data: {
      projectId: project1.id,
      entryType: 'fgd_transcript',
      title: 'FGD with Female Training Graduates - Ramallah',
      content: 'Focus group discussion conducted with 12 female graduates of the ICT training program in Ramallah. Participants expressed high satisfaction with the training content but noted challenges in securing interviews due to transportation barriers. Several participants mentioned that the confidence-building workshops were particularly valuable. Key quote: "The training gave me skills, but more importantly it gave me the confidence to apply for jobs I never thought I could get." Participants recommended adding a mentorship component to connect graduates with women already working in the tech sector.',
      participants: 12,
      location: 'Ramallah Community Center',
      dateConducted: new Date('2025-09-15'),
      facilitator: 'Sara Ahmad',
      themes: ['training_satisfaction', 'employment_barriers', 'gender', 'mentorship'],
      sentiment: 'positive',
    },
  });

  await prisma.qualitativeEntry.create({
    data: {
      projectId: project1.id,
      entryType: 'kii_notes',
      title: 'KII with Employer Partner - Nablus',
      content: 'Interview with HR manager at a local tech company that hosted 8 interns from the program. The employer noted that interns had strong technical skills but sometimes lacked workplace soft skills. They recommended incorporating more practical workplace simulation in the training. The company plans to hire 3 of the 8 interns as full-time employees. The employer emphasized the value of the internship bridge program in reducing hiring risk.',
      participants: 1,
      location: 'Nablus Tech Hub',
      dateConducted: new Date('2025-10-03'),
      facilitator: 'Sara Ahmad',
      themes: ['employer_feedback', 'soft_skills', 'internship_quality', 'hiring'],
      sentiment: 'positive',
    },
  });

  // Reports
  await prisma.report.create({
    data: {
      projectId: project1.id,
      type: 'quarterly_summary',
      title: 'Q3 2025 Progress Report - Youth Employment',
      donorFormat: 'giz',
      periodStart: new Date('2025-07-01'),
      periodEnd: new Date('2025-09-30'),
      aiNarrative: 'The Youth Employment & Skills Development Program continued to make strong progress during Q3 2025. A total of 342 youth have now completed vocational training programs, representing 43% achievement against the target of 800. The program maintained a positive trajectory with 87 new graduates this quarter alone...',
      status: 'published',
      fileUrl: null,
    },
  });

  await prisma.report.create({
    data: {
      projectId: project1.id,
      type: 'monthly_progress',
      title: 'December 2025 Monthly Update',
      donorFormat: 'giz',
      periodStart: new Date('2025-12-01'),
      periodEnd: new Date('2025-12-31'),
      status: 'draft',
    },
  });

  // Notifications
  await prisma.notification.create({
    data: {
      userId: adminUser.id,
      type: 'off_track_alert',
      title: 'Off-Track Indicator Alert',
      message: 'Small business grants (Youth Employment project) is off-track: 34 of 120 target achieved.',
      link: `/projects/${project1.id}/framework`,
      isRead: false,
    },
  });

  await prisma.notification.create({
    data: {
      userId: adminUser.id,
      type: 'assessment_ready',
      title: 'Assessment Scoping Complete',
      message: 'Mid-term evaluation for Youth Employment project is ready for review.',
      link: `/projects/${project1.id}/assessments`,
      isRead: false,
    },
  });

  await prisma.notification.create({
    data: {
      userId: adminUser.id,
      type: 'report_generated',
      title: 'Q3 Report Published',
      message: 'The Q3 2025 quarterly report for Youth Employment has been published.',
      link: `/projects/${project1.id}/reports`,
      isRead: true,
    },
  });

  await prisma.notification.create({
    data: {
      userId: meOfficer.id,
      type: 'deadline_reminder',
      title: 'Data Collection Deadline',
      message: 'Monthly data collection for January 2026 is due in 5 days.',
      isRead: false,
    },
  });

  // M&E Templates (deprecated: replaced by IndicatorLibraryEntry, kept while /api/templates still serves them)
  const templateData = [
    // === LIVELIHOODS (10 indicators) ===
    { sector: 'livelihoods' as const, text: 'Percentage increase in household income among beneficiaries', textAr: 'نسبة الزيادة في دخل الأسرة بين المستفيدين', level: 'impact' as const, method: 'hh_survey' as const, freq: 'annual' as const, target: '25%', benchmark: '15-30% achievable in WB/Gaza', donors: ['eu', 'giz', 'usaid'] },
    { sector: 'livelihoods' as const, text: 'Reduction in poverty rate among target communities', textAr: 'انخفاض معدل الفقر بين المجتمعات المستهدفة', level: 'impact' as const, method: 'hh_survey' as const, freq: 'baseline_endline' as const, target: '10%', benchmark: '29.2% poverty rate WB, 53% Gaza', donors: ['eu', 'undp'] },
    { sector: 'livelihoods' as const, text: 'Number of beneficiaries who gained employment after program completion', textAr: 'عدد المستفيدين الذين حصلوا على عمل بعد إتمام البرنامج', level: 'outcome' as const, method: 'hh_survey' as const, freq: 'biannual' as const, target: '60%', benchmark: '40-55% typical in WB', donors: ['giz', 'usaid', 'eu'] },
    { sector: 'livelihoods' as const, text: 'Percentage of training graduates who secured employment within 6 months', textAr: 'نسبة خريجي التدريب الذين حصلوا على عمل خلال 6 أشهر', level: 'outcome' as const, method: 'kii' as const, freq: 'biannual' as const, target: '50%', benchmark: '35-50% in Palestinian labor market', donors: ['giz', 'usaid'] },
    { sector: 'livelihoods' as const, text: 'Number of MSMEs established or strengthened through program support', textAr: 'عدد المنشآت الصغيرة والمتوسطة التي تم إنشاؤها أو تعزيزها', level: 'outcome' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '100', benchmark: null, donors: ['eu', 'giz'] },
    { sector: 'livelihoods' as const, text: 'Number of vocational training sessions delivered', textAr: 'عدد جلسات التدريب المهني المنفذة', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: 'Varies', benchmark: null, donors: ['giz', 'usaid', 'eu'] },
    { sector: 'livelihoods' as const, text: 'Number of youth (18-30) who completed skills training programs', textAr: 'عدد الشباب (18-30) الذين أكملوا برامج تنمية المهارات', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '500', benchmark: null, donors: ['giz', 'usaid'] },
    { sector: 'livelihoods' as const, text: 'Number of internship placements facilitated with private sector partners', textAr: 'عدد فرص التدريب العملي مع شركاء القطاع الخاص', level: 'output' as const, method: 'document_review' as const, freq: 'monthly' as const, target: '200', benchmark: null, donors: ['giz', 'usaid'] },
    { sector: 'livelihoods' as const, text: 'Number of small business grants disbursed to entrepreneurs', textAr: 'عدد منح الأعمال الصغيرة الممنوحة لرواد الأعمال', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '80', benchmark: null, donors: ['eu', 'usaid'] },
    { sector: 'livelihoods' as const, text: 'Percentage of female participants in economic empowerment activities', textAr: 'نسبة المشاركات في أنشطة التمكين الاقتصادي', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '50%', benchmark: '17% female labor force participation in Palestine', donors: ['eu', 'giz', 'sida'] },

    // === EDUCATION (10 indicators) ===
    { sector: 'education' as const, text: 'Percentage improvement in student learning outcomes (test scores)', textAr: 'نسبة التحسن في نتائج تعلم الطلاب', level: 'impact' as const, method: 'document_review' as const, freq: 'annual' as const, target: '15%', benchmark: '10-20% improvement achievable', donors: ['unicef', 'eu', 'usaid'] },
    { sector: 'education' as const, text: 'Reduction in school dropout rate in target schools', textAr: 'انخفاض معدل التسرب المدرسي في المدارس المستهدفة', level: 'impact' as const, method: 'document_review' as const, freq: 'annual' as const, target: '5%', benchmark: '1.5% dropout rate WB, higher in Gaza', donors: ['unicef', 'eu'] },
    { sector: 'education' as const, text: 'Number of students demonstrating improved academic performance', textAr: 'عدد الطلاب الذين أظهروا تحسناً في الأداء الأكاديمي', level: 'outcome' as const, method: 'document_review' as const, freq: 'biannual' as const, target: '70%', benchmark: null, donors: ['unicef', 'eu'] },
    { sector: 'education' as const, text: 'Percentage of teachers applying new teaching methodologies in classroom', textAr: 'نسبة المعلمين الذين يطبقون منهجيات التدريس الجديدة', level: 'outcome' as const, method: 'observation' as const, freq: 'quarterly' as const, target: '80%', benchmark: null, donors: ['unicef', 'eu'] },
    { sector: 'education' as const, text: 'Number of children with disabilities enrolled in inclusive education programs', textAr: 'عدد الأطفال ذوي الإعاقة المسجلين في برامج التعليم الشامل', level: 'outcome' as const, method: 'document_review' as const, freq: 'biannual' as const, target: 'Varies', benchmark: null, donors: ['unicef', 'sida'] },
    { sector: 'education' as const, text: 'Number of teachers trained in new pedagogical methodologies', textAr: 'عدد المعلمين المدربين على المنهجيات التربوية الجديدة', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '200', benchmark: null, donors: ['unicef', 'eu', 'usaid'] },
    { sector: 'education' as const, text: 'Number of schools equipped with digital learning tools', textAr: 'عدد المدارس المجهزة بأدوات التعلم الرقمي', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '50', benchmark: null, donors: ['unicef', 'eu'] },
    { sector: 'education' as const, text: 'Number of remedial education sessions delivered', textAr: 'عدد جلسات التعليم العلاجي المنفذة', level: 'output' as const, method: 'document_review' as const, freq: 'monthly' as const, target: '500', benchmark: null, donors: ['unicef', 'usaid'] },
    { sector: 'education' as const, text: 'Number of parent-teacher association meetings conducted', textAr: 'عدد اجتماعات مجالس الآباء والمعلمين المنعقدة', level: 'activity' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '40', benchmark: null, donors: ['unicef', 'eu'] },
    { sector: 'education' as const, text: 'Number of psychosocial support sessions for conflict-affected students', textAr: 'عدد جلسات الدعم النفسي للطلاب المتأثرين بالنزاع', level: 'output' as const, method: 'document_review' as const, freq: 'monthly' as const, target: '1000', benchmark: null, donors: ['unicef', 'sida'] },

    // === HEALTH (10 indicators) ===
    { sector: 'health' as const, text: 'Reduction in maternal mortality rate in target areas', textAr: 'انخفاض معدل وفيات الأمهات في المناطق المستهدفة', level: 'impact' as const, method: 'secondary_data' as const, freq: 'annual' as const, target: '15%', benchmark: '17 per 100,000 in Palestine', donors: ['eu', 'unicef', 'undp'] },
    { sector: 'health' as const, text: 'Percentage of target population with improved access to primary healthcare', textAr: 'نسبة السكان المستهدفين الذين تحسن وصولهم للرعاية الصحية الأولية', level: 'impact' as const, method: 'hh_survey' as const, freq: 'annual' as const, target: '40%', benchmark: '30-50% in Area C', donors: ['eu', 'undp'] },
    { sector: 'health' as const, text: 'Number of patients receiving essential health services', textAr: 'عدد المرضى الذين تلقوا الخدمات الصحية الأساسية', level: 'outcome' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '5000', benchmark: null, donors: ['eu', 'undp'] },
    { sector: 'health' as const, text: 'Percentage of pregnant women completing antenatal care visits', textAr: 'نسبة الحوامل اللواتي أكملن زيارات الرعاية السابقة للولادة', level: 'outcome' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '90%', benchmark: '96% nationally but lower in marginalized areas', donors: ['unicef', 'eu'] },
    { sector: 'health' as const, text: 'Percentage of children under 5 fully immunized', textAr: 'نسبة الأطفال دون 5 سنوات المحصنين بالكامل', level: 'outcome' as const, method: 'document_review' as const, freq: 'biannual' as const, target: '95%', benchmark: '97% nationally', donors: ['unicef', 'eu'] },
    { sector: 'health' as const, text: 'Number of primary healthcare consultations provided', textAr: 'عدد الاستشارات الصحية الأولية المقدمة', level: 'output' as const, method: 'document_review' as const, freq: 'monthly' as const, target: '10000', benchmark: null, donors: ['eu', 'undp'] },
    { sector: 'health' as const, text: 'Number of community health workers trained', textAr: 'عدد العاملين الصحيين المجتمعيين المدربين', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '100', benchmark: null, donors: ['eu', 'unicef'] },
    { sector: 'health' as const, text: 'Number of health facilities rehabilitated or equipped', textAr: 'عدد المرافق الصحية المؤهلة أو المجهزة', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '10', benchmark: null, donors: ['eu', 'undp'] },
    { sector: 'health' as const, text: 'Number of mental health and psychosocial support sessions provided', textAr: 'عدد جلسات الصحة النفسية والدعم النفسي الاجتماعي المقدمة', level: 'output' as const, method: 'document_review' as const, freq: 'monthly' as const, target: '2000', benchmark: null, donors: ['unicef', 'sida'] },
    { sector: 'health' as const, text: 'Number of health awareness campaigns conducted', textAr: 'عدد حملات التوعية الصحية المنفذة', level: 'activity' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '20', benchmark: null, donors: ['eu', 'unicef'] },

    // === WASH (8 indicators) ===
    { sector: 'wash' as const, text: 'Percentage of target households with access to safe drinking water', textAr: 'نسبة الأسر المستهدفة التي لديها وصول لمياه شرب آمنة', level: 'impact' as const, method: 'hh_survey' as const, freq: 'annual' as const, target: '80%', benchmark: '10% of WB communities lack safe water', donors: ['unicef', 'eu'] },
    { sector: 'wash' as const, text: 'Reduction in waterborne diseases in target communities', textAr: 'انخفاض الأمراض المنقولة بالمياه في المجتمعات المستهدفة', level: 'impact' as const, method: 'secondary_data' as const, freq: 'annual' as const, target: '30%', benchmark: null, donors: ['unicef', 'eu'] },
    { sector: 'wash' as const, text: 'Number of households with improved water supply infrastructure', textAr: 'عدد الأسر التي تحسنت بنية إمدادات المياه لديها', level: 'outcome' as const, method: 'hh_survey' as const, freq: 'biannual' as const, target: '500', benchmark: null, donors: ['unicef', 'eu'] },
    { sector: 'wash' as const, text: 'Percentage of households practicing proper hygiene behaviors', textAr: 'نسبة الأسر التي تمارس سلوكيات النظافة السليمة', level: 'outcome' as const, method: 'hh_survey' as const, freq: 'biannual' as const, target: '70%', benchmark: null, donors: ['unicef', 'eu'] },
    { sector: 'wash' as const, text: 'Number of water supply systems constructed or rehabilitated', textAr: 'عدد أنظمة إمدادات المياه المنشأة أو المؤهلة', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '15', benchmark: null, donors: ['unicef', 'eu'] },
    { sector: 'wash' as const, text: 'Number of latrines/sanitation facilities constructed', textAr: 'عدد المراحيض/مرافق الصرف الصحي المنشأة', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '200', benchmark: null, donors: ['unicef', 'eu'] },
    { sector: 'wash' as const, text: 'Number of hygiene promotion sessions conducted', textAr: 'عدد جلسات تعزيز النظافة المنفذة', level: 'activity' as const, method: 'document_review' as const, freq: 'monthly' as const, target: '100', benchmark: null, donors: ['unicef', 'eu'] },
    { sector: 'wash' as const, text: 'Number of schools with improved WASH facilities', textAr: 'عدد المدارس ذات مرافق المياه والصرف الصحي المحسنة', level: 'output' as const, method: 'observation' as const, freq: 'quarterly' as const, target: '30', benchmark: null, donors: ['unicef', 'eu'] },

    // === PROTECTION (8 indicators) ===
    { sector: 'protection' as const, text: 'Percentage of at-risk individuals reporting improved sense of safety', textAr: 'نسبة الأفراد المعرضين للخطر الذين أبلغوا عن تحسن شعورهم بالأمان', level: 'impact' as const, method: 'hh_survey' as const, freq: 'annual' as const, target: '60%', benchmark: null, donors: ['unicef', 'sida', 'undp'] },
    { sector: 'protection' as const, text: 'Number of GBV survivors accessing comprehensive support services', textAr: 'عدد الناجيات من العنف القائم على النوع الاجتماعي اللواتي حصلن على خدمات دعم شاملة', level: 'outcome' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '300', benchmark: null, donors: ['unicef', 'sida'] },
    { sector: 'protection' as const, text: 'Number of children receiving psychosocial support', textAr: 'عدد الأطفال الذين تلقوا دعماً نفسياً اجتماعياً', level: 'outcome' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '1000', benchmark: null, donors: ['unicef', 'sida'] },
    { sector: 'protection' as const, text: 'Number of legal aid cases processed', textAr: 'عدد حالات المساعدة القانونية المعالجة', level: 'output' as const, method: 'document_review' as const, freq: 'monthly' as const, target: '200', benchmark: null, donors: ['undp', 'sida'] },
    { sector: 'protection' as const, text: 'Number of community protection committees established and functional', textAr: 'عدد لجان الحماية المجتمعية المنشأة والفاعلة', level: 'output' as const, method: 'observation' as const, freq: 'quarterly' as const, target: '15', benchmark: null, donors: ['unicef', 'undp'] },
    { sector: 'protection' as const, text: 'Number of awareness sessions on child protection and rights', textAr: 'عدد جلسات التوعية حول حماية الطفل وحقوقه', level: 'activity' as const, method: 'document_review' as const, freq: 'monthly' as const, target: '50', benchmark: null, donors: ['unicef', 'sida'] },
    { sector: 'protection' as const, text: 'Number of safe spaces established for women and girls', textAr: 'عدد المساحات الآمنة المنشأة للنساء والفتيات', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '8', benchmark: null, donors: ['sida', 'unicef'] },
    { sector: 'protection' as const, text: 'Number of service providers trained on protection mainstreaming', textAr: 'عدد مقدمي الخدمات المدربين على تعميم الحماية', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '60', benchmark: null, donors: ['unicef', 'undp', 'sida'] },

    // === FOOD SECURITY (8 indicators) ===
    { sector: 'food_security' as const, text: 'Reduction in food insecurity prevalence among target households', textAr: 'انخفاض انتشار انعدام الأمن الغذائي بين الأسر المستهدفة', level: 'impact' as const, method: 'hh_survey' as const, freq: 'annual' as const, target: '20%', benchmark: '33% food insecurity in WB, 68% in Gaza', donors: ['eu', 'usaid', 'undp'] },
    { sector: 'food_security' as const, text: 'Improvement in household food consumption score (FCS)', textAr: 'تحسن درجة استهلاك الغذاء الأسري', level: 'outcome' as const, method: 'hh_survey' as const, freq: 'biannual' as const, target: '15%', benchmark: null, donors: ['eu', 'usaid'] },
    { sector: 'food_security' as const, text: 'Number of households receiving food assistance', textAr: 'عدد الأسر التي تلقت مساعدات غذائية', level: 'output' as const, method: 'document_review' as const, freq: 'monthly' as const, target: '2000', benchmark: null, donors: ['eu', 'usaid'] },
    { sector: 'food_security' as const, text: 'Number of farmers trained in climate-resilient agricultural practices', textAr: 'عدد المزارعين المدربين على الممارسات الزراعية المقاومة للمناخ', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '300', benchmark: null, donors: ['eu', 'giz'] },
    { sector: 'food_security' as const, text: 'Number of kitchen gardens established', textAr: 'عدد الحدائق المنزلية المنشأة', level: 'output' as const, method: 'observation' as const, freq: 'quarterly' as const, target: '500', benchmark: null, donors: ['eu', 'usaid'] },
    { sector: 'food_security' as const, text: 'Percentage of beneficiaries with improved dietary diversity score', textAr: 'نسبة المستفيدين الذين تحسنت درجة التنوع الغذائي لديهم', level: 'outcome' as const, method: 'hh_survey' as const, freq: 'biannual' as const, target: '30%', benchmark: null, donors: ['eu', 'usaid'] },
    { sector: 'food_security' as const, text: 'Number of food processing and preservation trainings conducted', textAr: 'عدد التدريبات على تصنيع وحفظ الأغذية المنفذة', level: 'activity' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '30', benchmark: null, donors: ['eu', 'giz'] },
    { sector: 'food_security' as const, text: 'Number of agricultural cooperatives supported', textAr: 'عدد التعاونيات الزراعية المدعومة', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '20', benchmark: null, donors: ['eu', 'giz'] },

    // === GOVERNANCE (8 indicators) ===
    { sector: 'governance' as const, text: 'Improvement in citizen satisfaction with local government services', textAr: 'تحسن رضا المواطنين عن خدمات الحكومة المحلية', level: 'impact' as const, method: 'hh_survey' as const, freq: 'annual' as const, target: '20%', benchmark: null, donors: ['undp', 'eu', 'giz'] },
    { sector: 'governance' as const, text: 'Number of local government units adopting transparent budgeting practices', textAr: 'عدد وحدات الحكم المحلي التي تبنت ممارسات الموازنة الشفافة', level: 'outcome' as const, method: 'document_review' as const, freq: 'biannual' as const, target: '10', benchmark: null, donors: ['undp', 'eu'] },
    { sector: 'governance' as const, text: 'Percentage of citizens participating in local planning processes', textAr: 'نسبة المواطنين المشاركين في عمليات التخطيط المحلي', level: 'outcome' as const, method: 'observation' as const, freq: 'biannual' as const, target: '30%', benchmark: null, donors: ['undp', 'giz'] },
    { sector: 'governance' as const, text: 'Number of community-led initiatives successfully implemented', textAr: 'عدد المبادرات المجتمعية المنفذة بنجاح', level: 'output' as const, method: 'observation' as const, freq: 'quarterly' as const, target: '25', benchmark: null, donors: ['undp', 'eu'] },
    { sector: 'governance' as const, text: 'Number of public officials trained in good governance principles', textAr: 'عدد الموظفين العموميين المدربين على مبادئ الحكم الرشيد', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '100', benchmark: null, donors: ['undp', 'giz'] },
    { sector: 'governance' as const, text: 'Number of youth and women participating in civic engagement activities', textAr: 'عدد الشباب والنساء المشاركين في أنشطة المشاركة المدنية', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '500', benchmark: null, donors: ['undp', 'sida'] },
    { sector: 'governance' as const, text: 'Number of accountability mechanisms established', textAr: 'عدد آليات المساءلة المنشأة', level: 'output' as const, method: 'document_review' as const, freq: 'biannual' as const, target: '5', benchmark: null, donors: ['undp', 'eu'] },
    { sector: 'governance' as const, text: 'Number of town hall meetings and public consultations held', textAr: 'عدد الاجتماعات البلدية والمشاورات العامة المنعقدة', level: 'activity' as const, method: 'observation' as const, freq: 'quarterly' as const, target: '30', benchmark: null, donors: ['undp', 'giz'] },

    // === AGRICULTURE (6 indicators) ===
    { sector: 'agriculture' as const, text: 'Percentage increase in agricultural yields among target farmers', textAr: 'نسبة الزيادة في الإنتاج الزراعي لدى المزارعين المستهدفين', level: 'impact' as const, method: 'hh_survey' as const, freq: 'annual' as const, target: '25%', benchmark: null, donors: ['eu', 'giz'] },
    { sector: 'agriculture' as const, text: 'Number of farmers adopting improved agricultural techniques', textAr: 'عدد المزارعين الذين تبنوا تقنيات زراعية محسنة', level: 'outcome' as const, method: 'observation' as const, freq: 'biannual' as const, target: '200', benchmark: null, donors: ['eu', 'giz'] },
    { sector: 'agriculture' as const, text: 'Hectares of agricultural land rehabilitated or improved', textAr: 'مساحة الأراضي الزراعية المؤهلة أو المحسنة بالهكتار', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '100', benchmark: null, donors: ['eu', 'giz'] },
    { sector: 'agriculture' as const, text: 'Number of water-saving irrigation systems installed', textAr: 'عدد أنظمة الري الموفرة للمياه المركبة', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '50', benchmark: null, donors: ['eu', 'giz'] },
    { sector: 'agriculture' as const, text: 'Number of agricultural extension sessions delivered', textAr: 'عدد جلسات الإرشاد الزراعي المنفذة', level: 'activity' as const, method: 'document_review' as const, freq: 'monthly' as const, target: '60', benchmark: null, donors: ['eu', 'giz'] },
    { sector: 'agriculture' as const, text: 'Number of women-led agricultural enterprises supported', textAr: 'عدد المشاريع الزراعية بقيادة النساء المدعومة', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '30', benchmark: null, donors: ['eu', 'sida'] },

    // === GENDER (6 indicators) ===
    { sector: 'gender' as const, text: 'Percentage of women reporting increased decision-making power within household', textAr: 'نسبة النساء اللواتي أبلغن عن زيادة قوة صنع القرار داخل الأسرة', level: 'impact' as const, method: 'hh_survey' as const, freq: 'annual' as const, target: '30%', benchmark: null, donors: ['sida', 'eu', 'undp'] },
    { sector: 'gender' as const, text: 'Number of women in leadership positions in target organizations', textAr: 'عدد النساء في المناصب القيادية في المنظمات المستهدفة', level: 'outcome' as const, method: 'document_review' as const, freq: 'biannual' as const, target: '50', benchmark: null, donors: ['sida', 'eu'] },
    { sector: 'gender' as const, text: 'Number of gender-responsive policies adopted by partner institutions', textAr: 'عدد السياسات المستجيبة للنوع الاجتماعي المعتمدة', level: 'outcome' as const, method: 'document_review' as const, freq: 'biannual' as const, target: '5', benchmark: null, donors: ['sida', 'undp'] },
    { sector: 'gender' as const, text: 'Number of women and girls participating in empowerment programs', textAr: 'عدد النساء والفتيات المشاركات في برامج التمكين', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '500', benchmark: null, donors: ['sida', 'eu'] },
    { sector: 'gender' as const, text: 'Number of gender awareness and advocacy campaigns conducted', textAr: 'عدد حملات التوعية والمناصرة بشأن النوع الاجتماعي المنفذة', level: 'activity' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '12', benchmark: null, donors: ['sida', 'eu', 'undp'] },
    { sector: 'gender' as const, text: 'Number of men and boys engaged in positive masculinity programs', textAr: 'عدد الرجال والفتيان المشاركين في برامج الذكورة الإيجابية', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '200', benchmark: null, donors: ['sida', 'unicef'] },

    // === YOUTH (6 indicators) ===
    { sector: 'youth' as const, text: 'Percentage of youth reporting improved life skills and self-efficacy', textAr: 'نسبة الشباب الذين أبلغوا عن تحسن المهارات الحياتية والكفاءة الذاتية', level: 'impact' as const, method: 'hh_survey' as const, freq: 'annual' as const, target: '40%', benchmark: null, donors: ['unicef', 'giz', 'undp'] },
    { sector: 'youth' as const, text: 'Number of youth-led community initiatives successfully implemented', textAr: 'عدد المبادرات المجتمعية بقيادة الشباب المنفذة بنجاح', level: 'outcome' as const, method: 'observation' as const, freq: 'quarterly' as const, target: '30', benchmark: null, donors: ['unicef', 'undp'] },
    { sector: 'youth' as const, text: 'Number of youth completing life skills and leadership training', textAr: 'عدد الشباب الذين أكملوا تدريب المهارات الحياتية والقيادة', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '300', benchmark: null, donors: ['unicef', 'giz'] },
    { sector: 'youth' as const, text: 'Number of youth engaged in volunteerism and civic participation', textAr: 'عدد الشباب المشاركين في العمل التطوعي والمشاركة المدنية', level: 'output' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '500', benchmark: null, donors: ['undp', 'unicef'] },
    { sector: 'youth' as const, text: 'Number of youth innovation hubs or spaces established', textAr: 'عدد مراكز أو مساحات الابتكار الشبابية المنشأة', level: 'output' as const, method: 'document_review' as const, freq: 'biannual' as const, target: '5', benchmark: null, donors: ['undp', 'giz'] },
    { sector: 'youth' as const, text: 'Number of youth entrepreneurship bootcamps conducted', textAr: 'عدد معسكرات ريادة الأعمال الشبابية المنفذة', level: 'activity' as const, method: 'document_review' as const, freq: 'quarterly' as const, target: '8', benchmark: null, donors: ['giz', 'undp'] },
  ];

  for (const t of templateData) {
    await prisma.mETemplate.create({
      data: {
        sector: t.sector,
        indicatorText: t.text,
        indicatorTextAr: t.textAr,
        level: t.level,
        recommendedMethod: t.method,
        recommendedFrequency: t.freq,
        typicalTarget: t.target,
        benchmarkPalestine: t.benchmark,
        donorRelevance: t.donors,
        tags: [t.sector, t.level],
      },
    });
  }

  console.log(`📊 Seeded ${templateData.length} M&E templates across ${new Set(templateData.map(t => t.sector)).size} sectors`);

  // Indicator library: idempotent upsert from knowledge/indicator-library.json (same as `npm run seed:library`),
  // then link the seeded indicators adapted from library entries.
  const library = await seedLibrary(prisma);
  console.log(`📚 Indicator library ${library.version}: ${library.total} entries (${library.created} created, ${library.updated} updated, ${library.unchanged} unchanged)`);

  const knownLibraryIds = new Set((await prisma.indicatorLibraryEntry.findMany({
    where: { id: { in: libraryLinks.map(l => l.libraryId) } },
    select: { id: true },
  })).map(e => e.id));
  for (const link of libraryLinks) {
    if (knownLibraryIds.has(link.libraryId)) {
      await prisma.indicator.update({ where: { id: link.indicatorId }, data: { libraryId: link.libraryId } });
    } else {
      console.warn(`⚠️  Library entry ${link.libraryId} is not in the library file; the seeded indicator is left unlinked`);
      await prisma.indicator.updateMany({ where: { id: link.indicatorId, provenance: 'library' }, data: { provenance: 'manual' } });
    }
  }

  const [resultCount, indicatorCount] = await Promise.all([prisma.resultNode.count(), prisma.indicator.count()]);
  console.log(`🧭 Seeded ${resultCount} results and ${indicatorCount} indicators (${knownLibraryIds.size} linked to library entries)`);

  console.log('✅ Seed completed successfully!');
  console.log('');
  console.log('Demo accounts:');
  if (passwordPlan.kind === 'sharedDemo') {
    console.log(`  Admin:   ${SEED_ACCOUNTS.admin} / ${passwordPlan.password}`);
    console.log(`  M&E:     ${SEED_ACCOUNTS.officer} / ${passwordPlan.password}`);
    console.log(`  Donor:   ${SEED_ACCOUNTS.donor} / ${passwordPlan.password}`);
    console.log('  (the local demo password; development only)');
  } else {
    console.log(`  Admin:   ${SEED_ACCOUNTS.admin} / <SEED_PASSWORD>`);
    console.log(`  M&E:     ${SEED_ACCOUNTS.officer} (no password yet)`);
    console.log(`  Donor:   ${SEED_ACCOUNTS.donor} (no password yet)`);
    console.log('  Sign in as the admin, then give each tester their own one-time password:');
    console.log('  Settings → Team members → Reset password.');
  }
  console.log('');
  console.log(`Projects: ${[project1, project2, project3, project4].map(p => p.name).join(', ')}`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

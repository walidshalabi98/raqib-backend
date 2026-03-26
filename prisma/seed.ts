import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding RAQIB database...');

  // Clean existing data
  await prisma.notification.deleteMany();
  await prisma.dataPoint.deleteMany();
  await prisma.qualitativeEntry.deleteMany();
  await prisma.indicator.deleteMany();
  await prisma.framework.deleteMany();
  await prisma.assessment.deleteMany();
  await prisma.document.deleteMany();
  await prisma.report.deleteMany();
  await prisma.mETemplate.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
  await prisma.project.deleteMany();
  await prisma.organization.deleteMany();

  // Organization
  const org = await prisma.organization.create({
    data: {
      name: 'Momentum Labs',
      nameAr: 'مومنتوم لابز',
      type: 'local_ngo',
      country: 'Palestine',
      city: 'Ramallah',
      contactEmail: 'info@momentumlabs.ps',
      contactPhone: '+970-2-123-4567',
      subscriptionStatus: 'active',
    },
  });

  // Users
  const passwordHash = await bcrypt.hash('admin123', 12);

  const adminUser = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: 'admin@momentumlabs.ps',
      passwordHash,
      fullName: 'Walid Shalabi',
      fullNameAr: 'وليد شلبي',
      role: 'org_admin',
      languagePref: 'en',
    },
  });

  const meOfficer = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: 'me@momentumlabs.ps',
      passwordHash,
      fullName: 'Sara Ahmad',
      fullNameAr: 'سارة أحمد',
      role: 'me_officer',
      languagePref: 'en',
    },
  });

  const donorViewer = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: 'donor@momentumlabs.ps',
      passwordHash,
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

  // Framework for Project 1
  const framework1 = await prisma.framework.create({
    data: {
      projectId: project1.id,
      version: 1,
      status: 'approved',
      aiModelUsed: 'claude-sonnet-4-20250514',
      approvedAt: new Date('2025-02-15'),
      approvedBy: adminUser.id,
    },
  });

  // Indicators for Project 1
  const indicators = await Promise.all([
    prisma.indicator.create({
      data: {
        frameworkId: framework1.id,
        indicatorText: 'Percentage increase in youth employment rate in target areas',
        indicatorTextAr: 'نسبة الزيادة في معدل توظيف الشباب في المناطق المستهدفة',
        level: 'impact',
        dataCollectionMethod: 'hh_survey',
        frequency: 'annual',
        baselineValue: '22',
        targetValue: '35',
        currentValue: '26',
        unit: '%',
        status: 'on_track',
        phases: ['baseline', 'midterm', 'endline'],
        aiRationale: 'Measures the overall employment impact on youth in target communities.',
        sortOrder: 0,
        isApproved: true,
      },
    }),
    prisma.indicator.create({
      data: {
        frameworkId: framework1.id,
        indicatorText: 'Number of youth who completed vocational training programs',
        indicatorTextAr: 'عدد الشباب الذين أكملوا برامج التدريب المهني',
        level: 'outcome',
        dataCollectionMethod: 'document_review',
        frequency: 'quarterly',
        baselineValue: '0',
        targetValue: '800',
        currentValue: '342',
        unit: 'number',
        status: 'on_track',
        phases: ['baseline', 'midterm', 'endline'],
        aiRationale: 'Tracks direct program output of trained youth.',
        sortOrder: 1,
        isApproved: true,
      },
    }),
    prisma.indicator.create({
      data: {
        frameworkId: framework1.id,
        indicatorText: 'Percentage of training graduates who secured employment within 6 months',
        indicatorTextAr: 'نسبة خريجي التدريب الذين حصلوا على عمل خلال 6 أشهر',
        level: 'outcome',
        dataCollectionMethod: 'kii',
        frequency: 'biannual',
        baselineValue: '0',
        targetValue: '60',
        currentValue: '45',
        unit: '%',
        status: 'at_risk',
        phases: ['midterm', 'endline'],
        aiRationale: 'Measures the effectiveness of training in leading to actual employment.',
        sortOrder: 2,
        isApproved: true,
      },
    }),
    prisma.indicator.create({
      data: {
        frameworkId: framework1.id,
        indicatorText: 'Number of internship placements facilitated',
        indicatorTextAr: 'عدد فرص التدريب العملي التي تم تيسيرها',
        level: 'output',
        dataCollectionMethod: 'document_review',
        frequency: 'monthly',
        baselineValue: '0',
        targetValue: '500',
        currentValue: '187',
        unit: 'number',
        status: 'on_track',
        phases: ['baseline', 'midterm', 'endline'],
        aiRationale: 'Tracks the program output of internship connections.',
        sortOrder: 3,
        isApproved: true,
      },
    }),
    prisma.indicator.create({
      data: {
        frameworkId: framework1.id,
        indicatorText: 'Number of small business grants disbursed to youth entrepreneurs',
        indicatorTextAr: 'عدد منح الأعمال الصغيرة الممنوحة لرواد الأعمال الشباب',
        level: 'output',
        dataCollectionMethod: 'document_review',
        frequency: 'quarterly',
        baselineValue: '0',
        targetValue: '120',
        currentValue: '34',
        unit: 'number',
        status: 'off_track',
        phases: ['baseline', 'midterm', 'endline'],
        aiRationale: 'Measures entrepreneurship support component delivery.',
        sortOrder: 4,
        isApproved: true,
      },
    }),
    prisma.indicator.create({
      data: {
        frameworkId: framework1.id,
        indicatorText: 'Number of training sessions conducted per quarter',
        indicatorTextAr: 'عدد جلسات التدريب المنفذة لكل ربع سنة',
        level: 'activity',
        dataCollectionMethod: 'observation',
        frequency: 'monthly',
        baselineValue: '0',
        targetValue: '48',
        currentValue: '22',
        unit: 'number',
        status: 'on_track',
        phases: ['baseline', 'midterm', 'endline'],
        aiRationale: 'Tracks implementation pace of training activities.',
        sortOrder: 5,
        isApproved: true,
      },
    }),
    prisma.indicator.create({
      data: {
        frameworkId: framework1.id,
        indicatorText: 'Percentage of female participants in training programs',
        indicatorTextAr: 'نسبة المشاركات الإناث في برامج التدريب',
        level: 'output',
        dataCollectionMethod: 'document_review',
        frequency: 'quarterly',
        baselineValue: '30',
        targetValue: '50',
        currentValue: '42',
        unit: '%',
        status: 'on_track',
        phases: ['baseline', 'midterm', 'endline'],
        aiRationale: 'Gender mainstreaming indicator to ensure equitable access.',
        sortOrder: 6,
        isApproved: true,
      },
    }),
  ]);

  // Data Points
  const dataPointsData = [
    { indicatorId: indicators[0].id, value: '22', date: '2025-01-15', method: 'hh_survey' as const },
    { indicatorId: indicators[0].id, value: '24', date: '2025-06-15', method: 'hh_survey' as const },
    { indicatorId: indicators[0].id, value: '26', date: '2025-12-15', method: 'hh_survey' as const },
    { indicatorId: indicators[1].id, value: '0', date: '2025-01-15', method: 'document_review' as const },
    { indicatorId: indicators[1].id, value: '85', date: '2025-03-31', method: 'document_review' as const },
    { indicatorId: indicators[1].id, value: '178', date: '2025-06-30', method: 'document_review' as const },
    { indicatorId: indicators[1].id, value: '265', date: '2025-09-30', method: 'document_review' as const },
    { indicatorId: indicators[1].id, value: '342', date: '2025-12-31', method: 'document_review' as const },
    { indicatorId: indicators[2].id, value: '0', date: '2025-06-30', method: 'kii' as const },
    { indicatorId: indicators[2].id, value: '45', date: '2025-12-31', method: 'kii' as const },
    { indicatorId: indicators[3].id, value: '0', date: '2025-01-31', method: 'document_review' as const },
    { indicatorId: indicators[3].id, value: '45', date: '2025-03-31', method: 'document_review' as const },
    { indicatorId: indicators[3].id, value: '98', date: '2025-06-30', method: 'document_review' as const },
    { indicatorId: indicators[3].id, value: '142', date: '2025-09-30', method: 'document_review' as const },
    { indicatorId: indicators[3].id, value: '187', date: '2025-12-31', method: 'document_review' as const },
    { indicatorId: indicators[4].id, value: '0', date: '2025-03-31', method: 'document_review' as const },
    { indicatorId: indicators[4].id, value: '12', date: '2025-06-30', method: 'document_review' as const },
    { indicatorId: indicators[4].id, value: '22', date: '2025-09-30', method: 'document_review' as const },
    { indicatorId: indicators[4].id, value: '34', date: '2025-12-31', method: 'document_review' as const },
  ];

  for (const dp of dataPointsData) {
    await prisma.dataPoint.create({
      data: {
        indicatorId: dp.indicatorId,
        projectId: project1.id,
        value: dp.value,
        collectionDate: new Date(dp.date),
        collectionMethod: dp.method,
        dataSource: 'Manual entry',
        geographicArea: ['Ramallah', 'Nablus', 'Hebron'][Math.floor(Math.random() * 3)],
        createdBy: meOfficer.id,
      },
    });
  }

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

  // M&E Templates — comprehensive library covering all sectors with Palestinian context
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

  console.log('✅ Seed completed successfully!');
  console.log('');
  console.log('Demo accounts:');
  console.log('  Admin:   admin@momentumlabs.ps / admin123');
  console.log('  M&E:     me@momentumlabs.ps / admin123');
  console.log('  Donor:   donor@momentumlabs.ps / admin123');
  console.log('');
  console.log(`Projects: ${project1.name}, ${project2.name}, ${project3.name}`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

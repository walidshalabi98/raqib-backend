# Raqib M&E Knowledge Base — Foundations

Version 1.0 · October 2026 · Owner: Raqib product team

This file is the single source of M&E rules for Raqib. It has two readers:

1. **The AI features** (framework generator, KPI assistant, alternatives, report narrative, monitoring engine). Sections 1–9 are written to be loaded into the system prompt. Keep them short and rule-like.
2. **Developers and Claude Code**, who use it to understand what the product must enforce in code (validation rules, required fields, defaults).

When this file and a donor's own guidance disagree, the donor guidance wins for that project. Section 11 lists the sources; re-check them yearly because donor frameworks change.

---

## 1. Core vocabulary (use these terms consistently in UI and AI output)

| Term | Meaning in Raqib |
|---|---|
| Goal / Impact | The long-term change the project contributes to but does not control alone (e.g., reduced food insecurity in a governorate). |
| Outcome | The change in behaviour, capacity, access or conditions among the target group that the project is directly accountable for influencing by the end of the project. |
| Output | Products, goods and services the project delivers (people trained, kits distributed, water points rehabilitated). DG ECHO calls these "Results". |
| Activity | Actions the team carries out to produce outputs. Activities are tracked as tasks and milestones, not normally as indicators. |
| Results chain | Activities → Outputs → Outcomes → Goal, each link resting on stated assumptions. |
| Logframe | A table of the results chain with indicators, means of verification and assumptions at each level. |
| Theory of Change | The narrative and diagram explaining why the results chain is expected to work, including assumptions and context. |
| Indicator | A variable that shows whether a result is being achieved. It names *what* is measured; it never contains the target. |
| Baseline | The indicator value before the intervention starts, with the date and method of measurement. |
| Target | The value the project intends to reach by a stated date. Intermediate (annual/midterm) targets are allowed. |
| Means of verification (MoV) | The specific source and tool used to measure the indicator (e.g., "household survey, FCS module, n≈400, representative of target households"). Generic answers such as "project reports" are not acceptable. |
| Disaggregation | Breaking the indicator value down by groups (sex, age, disability, location, displacement status, etc.). |
| KPI | In Raqib, a KPI is an indicator the organisation chooses to track on its dashboard. All KPIs are indicators; not all indicators are KPIs. |
| MEAL | Monitoring, Evaluation, Accountability and Learning. Accountability to affected people is part of M&E in humanitarian settings. |

## 2. Rules for a good indicator (the quality checklist)

Every indicator Raqib creates or suggests must pass these checks. The code should enforce the mechanical ones; the AI must apply all of them.

1. **One dimension only.** No "and/or" combining two measurements ("% of youth employed and satisfied" is two indicators).
2. **Neutral wording.** The indicator states what is measured, not the desired direction or target. Write "% of households with acceptable Food Consumption Score", not "Increase to 80% the households…". Direction and target are separate fields.
3. **Defined unit.** Number, percentage, score, ratio, index, currency, or yes/no. Percentages must have an explicit numerator and denominator.
4. **Measurable with the project's means.** There must be a realistic data source and method within the project's budget and access constraints.
5. **Level fits the result.** Output indicators count deliverables; outcome indicators measure change among people or institutions; impact indicators are usually population-level and often from secondary data.
6. **Time-bound.** Baseline date, target date and collection frequency are recorded.
7. **Disaggregated where it concerns people.** Sex is the minimum for any indicator counting or measuring people; age and disability are expected in most humanitarian and EU-funded work (see §4).
8. **Attributable enough.** Outcome indicators should be plausibly influenced by the project; if the change depends heavily on others, record that as an assumption.
9. **Not duplicated.** Two indicators in the same framework should not measure the same thing at the same level.
10. **Standard first.** Prefer an established indicator (donor framework, cluster standard, recognised tool) over a custom one. Create a custom indicator only when no standard indicator fits, and say why.

**Number of indicators.** Keep frameworks lean: typically 1–2 per goal, 2–4 per outcome, 2–3 per output. DG ECHO caps indicators at 3 per sub-sector (4 if one custom indicator is justified) — the system must enforce donor caps where they exist.

## 3. Indicator reference sheet (fields every indicator should eventually have)

Raqib stores and displays these fields. The AI fills what it can and marks the rest "to be confirmed by the M&E officer".

- Name (English) and name (Arabic)
- Result it measures (link to a goal/outcome/output node)
- Level (impact / outcome / output)
- Definition — what exactly counts, key terms defined
- Unit and calculation — numerator, denominator, formula, rounding
- Desired direction — increase / decrease / maintain
- Disaggregation — required and optional groups
- Data source and means of verification — tool, respondents, sample
- Collection method — household survey, KII, FGD, observation, records/document review, participatory method, secondary data
- Frequency and timing — e.g., quarterly; baseline + endline
- Baseline value, date and method (or "pending baseline")
- Targets — final and intermediate, with justification
- Responsible person/role
- Standard reference — library ID and the framework code (e.g., GERF 2.38, ECHO KRI, IASC MHPSS O5.4) if aligned
- Assumptions and data limitations
- Provenance — library, AI-suggested (model + prompt version), imported, or manual

## 4. Disaggregation defaults

- **Sex** (female/male) is the minimum for every people-level indicator. EU Global Europe methodological notes make sex or gender disaggregation mandatory for people-count indicators (for example GERF 2.32).
- **Age** — use the donor's bands where specified. Raqib's default bands for beneficiaries: 0–5, 6–11, 12–17, 18–24, 25–59, 60+ (already in the schema). EU GERF notes may use different bands (e.g., 0–4, 5–14, 15–19, 20+); store raw age or date of birth where possible so any banding can be produced later.
- **Disability** — use the Washington Group Short Set (WG-SS) for adults: six domains (seeing, hearing, walking/climbing steps, remembering/concentrating, self-care, communication), each answered on a four-point scale from "no difficulty" to "cannot do at all". For children use the Washington Group/UNICEF Child Functioning Module. Never ask "Are you disabled?" as a yes/no question.
- **Location** — governorate and locality (West Bank governorates, Gaza Strip governorates, East Jerusalem as reported by the organisation).
- **Displacement status** — resident, internally displaced, returnee, refugee, host community, as relevant.
- **Other context-specific groups** — female-headed households, persons in Area C communities, Bedouin/herding communities, etc., only where the project targets them.

## 5. Choosing data collection methods

| Method (schema value) | Best for | Watch-outs |
|---|---|---|
| hh_survey | Outcome indicators on households/individuals (consumption, income, practices, access) | Needs a sampling design; cost; seasonality |
| kii | Institutional change, policy, service quality from expert views | Not statistically representative |
| fgd | Perceptions, norms, reasons behind numbers | Not for prevalence figures; facilitation quality matters |
| observation | Infrastructure function, practices (handwashing stations, classroom practice) | Observer effect; needs checklist |
| document_review | Output counts from attendance sheets, distribution lists, registers | Data quality depends on record keeping |
| participatory | Community scorecards, most significant change, ranking | Facilitation-heavy; good for accountability |
| secondary_data | Impact-level indicators from PCBS, ministries, cluster data, UN agencies | Timeliness and geographic match |

Rule of thumb: outputs → records; outcomes → surveys plus qualitative explanation; impact → secondary data plus evaluation.

## 6. Baselines and targets

- A baseline is required for every outcome and impact indicator. If it is not available at design stage, record "pending baseline" with a planned date. DG ECHO requires the baseline at the latest in the interim report.
- **The AI must not invent baseline or target values.** It may: (a) copy values found in uploaded documents, citing the document; (b) suggest a *method* for setting the target (e.g., "baseline + 15 percentage points, consistent with similar programmes; confirm after baseline survey"); (c) cite a recognised standard threshold where one exists (e.g., Sphere minimum of 15 litres of water per person per day). All such values are marked "proposed".
- Output targets usually come from the proposal and budget (number of people, kits, trainings). The AI may extract them from documents.
- Units must match between baseline and target.

## 7. Data quality (DQA standards)

Five standards are used across donors for data quality assessments:

- **Validity** — the data measure the intended result.
- **Integrity** — safeguards against transcription errors and manipulation.
- **Precision** — enough detail for management decisions (e.g., sample size and margin of error are adequate).
- **Reliability** — consistent collection and analysis methods over time.
- **Timeliness** — frequent and current enough to inform decisions.

Product implications: keep an audit trail of every data point change (exists); store method, source and collector per data point (exists); flag values outside expected ranges; flag indicators whose data are older than their frequency allows.

## 8. Evaluation criteria (OECD DAC, 2019)

Evaluations and evaluation-related reports are structured around six criteria: **relevance, coherence (added in 2019), effectiveness, efficiency, impact and sustainability**. Raqib's midterm/endline assessment templates and report narratives should map findings to these criteria when the donor asks for an evaluation.

## 9. Accountability to affected people

Humanitarian donors expect organisations to show that people can participate, give feedback and complain safely. The Core Humanitarian Standard (CHS, 2024 edition) sets nine commitments to people and communities, including participation in decisions, safe reporting of concerns and complaints, and support that is adapted based on feedback.

Raqib should offer accountability indicators in every humanitarian framework, for example: % of people who know how to give feedback or complain; % of complaints responded to within the agreed time; % of people who report being treated with respect; % of people who report that assistance met their priority needs.

## 10. Donor and standards landscape (how the KPI assistant should prioritise)

When suggesting indicators, check in this order:

1. **The donor's own required indicators** for the project's sector.
   - **EU (DG INTPA / DG MENA, NDICI–Global Europe):** Global Europe Results Framework (GERF) — 87 indicators in three levels. Level 2 (2.1–2.39) is used in logframes; Level 3 is not used in logframes. Partners should use relevant GERF Level 2 indicators first, then other predefined OPSYS indicators (including Gender Action Plan III indicators), and create custom indicators only when nothing predefined fits. Each GERF indicator has a methodological note with definition, disaggregation and calculation.
   - **DG ECHO (EU humanitarian aid):** Key Result Indicators (KRIs) per sub-sector; compulsory KRIs must be selected; maximum 3 indicators per sub-sector (4 with one justified custom indicator) as of 2027; custom indicators must be SMART and must not include targets or data sources in the definition; baseline compulsory; source and method must be specific.
   - **UN agencies (UNDP, UNICEF, WFP, UNFPA):** align with the agency's strategic plan indicators and the SDG global indicator framework (231 unique indicators as of late 2024).
   - **German cooperation (GIZ/BMZ), Sida, FCDO and others:** results-based monitoring with logframes; use standard sector indicators and SDG alignment.
   - **US Government:** USAID ceased administering foreign assistance awards on 1 July 2025 and remaining programmes moved to the State Department. Treat "USAID" as a legacy donor type; existing awards may still use USAID-era indicator reference sheets.
2. **Cluster and sector standards** — Humanitarian Indicators Registry (cluster-agreed needs and response indicators), Sphere minimum standards, WFP food security indicators (FCS, rCSI, LCS, CARI), JMP WASH service ladders, IASC MHPSS M&E framework.
3. **Raqib's own indicator library** (knowledge/indicator-library.json and the database table it seeds).
4. **A custom indicator**, written to the §2 checklist, flagged as custom with a reason.

### Key sector references (summaries)

- **Food security (WFP):** Food Consumption Score — 7-day recall, 8 weighted food groups; household thresholds poor 0–21, borderline 21.5–35, acceptable >35 (adjusted 28/42 cut-offs where oil and sugar consumption is high; confirm which cut-offs apply locally). CARI combines FCS, reduced Coping Strategies Index (rCSI), Livelihood Coping Strategies (LCS-FS) and either ECMEN or Food Expenditure Share to classify households from food secure to severely food insecure.
- **WASH (Sphere):** at least 15 litres of water per person per day (aim for 20 where possible); water point within 500 m of households; queuing no more than 30 minutes; no more than 250 people per tap; 0 faecal coliforms per 100 ml at point of delivery; free residual chlorine 0.2–0.5 mg/l for piped supply. **JMP drinking water ladder:** safely managed, basic (≤30 min round trip), limited (>30 min), unimproved, surface water.
- **MHPSS (IASC common M&E framework, 2017):** goal-level indicators on functioning, subjective well-being, disabling distress, coping, social behaviour, social connectedness; outcome indicators on do-no-harm, protection, family and community support, and use of focused care. Tools are chosen by the organisation (WHO-DAS is cited for functioning).

## 11. Palestine context rules for the AI

- Use the official Palestinian Central Bureau of Statistics (PCBS) and ministries as secondary sources; cite publication and year.
- Data collection must account for movement restrictions, closures, and access constraints (especially Gaza and Area C). Suggest remote methods (phone surveys, partner-collected records) where field access is uncertain, and say so as an assumption.
- Respect protection risks: no indicators or questions that expose respondents to harm; sensitive topics (GBV, child protection, MHPSS) use specialist tools and trained staff, and data are aggregated.
- Keep language neutral and professional; avoid political characterisations in AI output.
- Arabic text must be Modern Standard Arabic suitable for donor and ministry readers.

## 12. Privacy rules for the AI pipeline (non-negotiable)

- Never send beneficiary-level personal data (names, national IDs, phone numbers, exact addresses) to any AI model. AI features receive aggregates only.
- Uploaded documents may contain personal data; the parser should redact phone numbers and ID numbers before text is stored for AI use.
- Store AI inputs/outputs needed for audit, but never in public storage.

## 13. Sources (checked October 2026)

- OECD DAC, *Better Criteria for Better Evaluation* (2019): https://www.oecd.org/en/publications/better-criteria-for-better-evaluation_15a9c26b-en.html
- EU, Global Europe Results Framework (GERF): https://capacity4dev.europa.eu/global-europe-results-framework-gerf · indicator list: https://capacity4dev.europa.eu/resources/results-indicators/global-europe-results-framework_en · example methodological note (GERF 2.32): https://capacity4dev.europa.eu/system/files/documents/2026-03/GERF%202.32%20Food%20insecure%20people%20-%20FINAL%20260226.pdf
- DG ECHO Partners' Helpdesk, Single Form 7.3 Results: https://dgecho-partners-helpdesk.eu/io/action-proposal/fill-in-the-single-form/7-logic-of-intervention/73-results
- Humanitarian Indicators Registry: https://humanitarian.atlassian.net/wiki/spaces/hpc/pages/4015980547/Humanitarian+Indicators+Registry
- Sphere, Water supply standard (interactive): https://interactive.spherestandards.org/
- WHO/UNICEF JMP drinking water ladder: https://washdata.org/node/19
- WFP Food Consumption Score (Indicator Compendium): https://monitoringhandbook.manuals.wfp.org/wfp-indicator-compendium/docs/1-food-consumption-score · CARI: https://vamresources.manuals.wfp.org/docs/the-consolidated-approach-for-reporting-indicators-of-food-security-cari
- IASC Common M&E Framework for MHPSS (2017): https://globalprotectioncluster.org/sites/default/files/2022-05/iasc_common_monitoring_and_evaluation_framework_for_mhpss_programmes_in_emergency_settings_0.pdf
- Washington Group Short Set: https://asro.unfpa.org/sites/default/files/pub-pdf/wgq.v4.2.pdf
- Data quality standards (USAID Learning Lab): https://usaidlearninglab.org/node/28042
- Core Humanitarian Standard 2024: https://inee.org/sites/default/files/resources/ENG_CHS_2024_RGB.pdf
- SDG indicator framework review (IISD, 2024): https://sdg.iisd.org/news/iaeg-sdgs-updates-on-2025-review-of-global-indicator-framework/
- USAID transfer to State Department (GAO-26-108607, Sept 2026): https://www.gao.gov/products/gao-26-108607
- Save the Children indicator reference format (example): https://indicators.savethechildren.net/indicator/110-households-with-access-to-sufficient-food

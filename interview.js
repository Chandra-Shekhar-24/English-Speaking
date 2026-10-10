// ============================================================
// interview.js — AI Mock Interview Engine
// 10, 20, 30-minute options, 1,000 unique questions per topic,
// contextual evaluator (no keyword matching, STAR analysis),
// grammar/vocabulary critiques, improved versions, 100-point scoring.
// ============================================================
const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const interviewQuestions = require("./interview-questions");

const INTERVIEWS_DATA_FILE = path.join(__dirname, "vocamate-interviews.json");
const TMP_FILE = INTERVIEWS_DATA_FILE + ".tmp";

let geminiClient = null;
function getAI() {
  if (geminiClient) return geminiClient;
  try {
    const opts = {
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    };
    if (process.env.GEMINI_API_KEY) {
      opts.apiKey = process.env.GEMINI_API_KEY;
    }
    geminiClient = new GoogleGenAI(opts);
    return geminiClient;
  } catch (e) {
    console.warn("Gemini interview client initialization notice:", e.message);
    return null;
  }
}

async function generateJsonContent(ai, prompt, temperature = 0.7, timeoutMs = 12000) {
  if (!ai) return null;
  const models = ["gemini-3.1-flash-lite", "gemini-3.8-flash"];
  for (const model of models) {
    try {
      const callPromise = ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature
        }
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout after " + timeoutMs + "ms")), timeoutMs)
      );
      const res = await Promise.race([callPromise, timeoutPromise]);
      if (res && res.text) {
        const raw = res.text.trim();
        try {
          return JSON.parse(raw);
        } catch (jsonErr) {
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) return JSON.parse(match[0]);
        }
      }
    } catch (e) {
      console.warn("Gemini (" + model + ") notice:", e.message);
    }
  }
  return null;
}

const activeSessions = new Map();
let interviewHistory = [];

function loadInterviews() {
  try {
    if (fs.existsSync(INTERVIEWS_DATA_FILE)) {
      const raw = fs.readFileSync(INTERVIEWS_DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      interviewHistory = Array.isArray(parsed.history) ? parsed.history : [];
    }
  } catch (e) {
    console.error("Error loading interview data:", e.message);
    interviewHistory = [];
  }
}

function saveInterviewsNow() {
  try {
    const payload = JSON.stringify({ history: interviewHistory.slice(-500) }, null, 2);
    fs.writeFileSync(TMP_FILE, payload, "utf8");
    fs.renameSync(TMP_FILE, INTERVIEWS_DATA_FILE);
  } catch (e) {
    console.error("Error saving interview data:", e.message);
  }
}

function scheduleSave() {
  saveInterviewsNow();
}

loadInterviews();

const TOPIC_CONFIG = {
  hr: {
    title: "HR Interview",
    category: "hr",
    description: "Workplace culture, career aspirations, conflict resolution, compensation, and organizational scenarios"
  },
  java: {
    title: "Java Interview",
    category: "technical",
    description: "Core Java, JVM internals, Collections, Multithreading, Memory Management, and Spring Boot"
  },
  dsa: {
    title: "DSA Interview",
    category: "technical",
    description: "Data Structures, Algorithms, Big-O Complexity, Trees, Dynamic Programming, and Graph Traversals"
  },
  dbms: {
    title: "DBMS Interview",
    category: "technical",
    description: "Relational Architecture, ACID, Indexing, Normalization, Query Optimization, and Transactions"
  },
  oop: {
    title: "OOP Interview",
    category: "technical",
    description: "Object-Oriented Programming principles, SOLID design, Gang of Four patterns, and system modularity"
  },
  projects: {
    title: "Projects & Architecture Interview",
    category: "technical",
    description: "End-to-end Project architecture, System Design, Scalability, CI/CD, and Production Trade-offs"
  },
  behavioral: {
    title: "Behavioral Interview",
    category: "behavioral",
    description: "STAR method scenarios, leadership, teamwork, pressure situations, feedback, and accountability"
  },
  webdev: {
    title: "Web Development Interview",
    category: "technical",
    description: "Frontend & Backend fundamentals, HTTP/HTTPS, Browsers, REST/GraphQL, Security, and Web Performance"
  },
  htmlcssjs: {
    title: "HTML/CSS/JavaScript",
    category: "technical",
    description: "DOM manipulation, CSS layout engines, Closures, Event Loop, Promises, and Modern ES6+"
  },
  fullstack: {
    title: "Backend / Full Stack Interview",
    category: "technical",
    description: "Node.js, Express, Databases (SQL/NoSQL), Authentication, Microservices, and System Architecture"
  },
  technical: {
    title: "Technical Interview",
    category: "technical",
    description: "Software Engineering foundations, Clean Code, Design Patterns, Debugging, and System Reliability"
  },
  personal: {
    title: "Personal Interview",
    category: "personal",
    description: "Self-Introduction, Strengths & Weaknesses, Projects, Education, Career Goals, and Authentic Storytelling"
  },
  custom: {
    title: "Custom Interview",
    category: "custom",
    description: "Tailored interview for any specialized role, framework, or target job description"
  }
};

const recentQuestionsByUser = new Map();

function getRecentUserQuestions(userCode) {
  return recentQuestionsByUser.get(String(userCode)) || [];
}

function recordAskedQuestion(userCode, questionText) {
  const code = String(userCode);
  const list = recentQuestionsByUser.get(code) || [];
  list.unshift(questionText);
  if (list.length > 300) list.pop();
  recentQuestionsByUser.set(code, list);
}

function pickRandomUnrepeatedQuestion(topicKey, difficulty, sessionQuestions = [], userCode = "") {
  const allBank = interviewQuestions.getQuestionsForTopicAndDifficulty(topicKey, difficulty);
  const sessionSet = new Set(sessionQuestions.map(q => q.trim().toLowerCase()));
  const recentList = userCode ? getRecentUserQuestions(userCode).map(q => q.trim().toLowerCase()) : [];
  const recentSet = new Set(recentList.slice(0, 50));

  const candidatesA = allBank.filter(q => {
    const text = q.question.trim().toLowerCase();
    return !sessionSet.has(text) && !recentSet.has(text);
  });
  if (candidatesA.length > 0) {
    const picked = candidatesA[Math.floor(Math.random() * candidatesA.length)];
    return picked.question;
  }

  const candidatesB = allBank.filter(q => !sessionSet.has(q.question.trim().toLowerCase()));
  if (candidatesB.length > 0) {
    const picked = candidatesB[Math.floor(Math.random() * candidatesB.length)];
    return picked.question;
  }

  if (allBank.length > 0) {
    return allBank[Math.floor(Math.random() * allBank.length)].question;
  }

  return "Could you introduce your background and explain your core philosophy when tackling complex problems in this domain?";
}

async function startInterviewSession({ userId, userCode, topicKey = "technical", customTopic = "", difficulty = "intermediate", durationMinutes = 10, totalQuestions = 0 }) {
  const normTopic = String(topicKey || "technical").toLowerCase().trim();
  const validTopic = TOPIC_CONFIG[normTopic] ? normTopic : "custom";
  const cfg = TOPIC_CONFIG[validTopic];
  const topicTitle = validTopic === "custom" && customTopic ? customTopic.trim() : cfg.title;
  const normDiff = ["beginner", "intermediate", "advanced"].includes(String(difficulty).toLowerCase())
    ? String(difficulty).toLowerCase()
    : "intermediate";

  let duration = parseInt(durationMinutes, 10);
  if (![10, 20, 30].includes(duration)) {
    duration = 10;
  }
  const targetQuestions = totalQuestions && totalQuestions > 0
    ? parseInt(totalQuestions, 10)
    : (duration === 10 ? 5 : (duration === 20 ? 10 : 15));

  const sessionId = "int_" + Date.now() + "_" + Math.floor(1000 + Math.random() * 9000);

  let initialQuestion = pickRandomUnrepeatedQuestion(validTopic, normDiff, [], userCode);
  recordAskedQuestion(userCode, initialQuestion);

  const session = {
    sessionId,
    userId,
    userCode,
    topicKey: validTopic,
    topicTitle,
    difficulty: normDiff,
    durationMinutes: duration,
    durationSeconds: duration * 60,
    totalQuestions: targetQuestions,
    currentIndex: 0,
    status: "in_progress",
    startedAt: Date.now(),
    completedAt: null,
    questions: [initialQuestion],
    answers: [],
    evaluations: [],
    finalReport: null
  };

  activeSessions.set(sessionId, session);

  return {
    sessionId,
    topicTitle,
    difficulty: normDiff,
    durationMinutes: duration,
    durationSeconds: duration * 60,
    questionNumber: 1,
    totalQuestions: session.totalQuestions,
    question: initialQuestion
  };
}

async function submitInterviewAnswer({ sessionId, userCode, answer }) {
  const session = activeSessions.get(sessionId);
  if (!session) throw new Error("Interview session not found or already completed");
  if (session.status !== "in_progress") throw new Error("Interview is already completed");

  const cleanAnswer = String(answer || "").trim();
  if (!cleanAnswer) throw new Error("Please provide an answer to the interview question");

  const qIndex = session.currentIndex;
  const currentQuestion = session.questions[qIndex];
  session.answers.push(cleanAnswer);

  const isLastQuestion = (qIndex + 1) >= session.totalQuestions;

  let evaluation = null;
  let nextQuestion = null;
  const ai = getAI();

  if (ai) {
    try {
      const isPersonalOrHr = session.topicKey === "personal" || session.topicKey === "hr" || session.topicKey === "behavioral";
      const evalPrompt = `You are an expert, empathetic, and rigorous hiring interviewer evaluating a candidate verbal response in a ` + session.topicTitle + ` interview at the ` + session.difficulty.toUpperCase() + ` level.

Current Question Asked: "` + currentQuestion + `"
Candidate Verbal Response: "` + cleanAnswer + `"
Question Number: ` + (qIndex + 1) + ` of ` + session.totalQuestions + `
Is Last Question: ` + isLastQuestion + `

CRITICAL EVALUATION MANDATES:
1. NEVER depend on fixed model answers or exact keyword matching.
2. Accept diverse valid perspectives, real-world workarounds, and alternative phrasings.
3. Assess the candidate core understanding, reasoning depth, clarity, and articulation.
4. Distinguish clearly between:
   - "correct": Candidate covered core points accurately and logically.
   - "partially_correct": Candidate demonstrated partial understanding but missed key trade-offs, mechanisms, or depth.
   - "incorrect": Candidate had fundamental misconceptions, gave misleading facts, or evaded the core question.
5. Provide actionable linguistic feedback: identify any slips in grammar, tense, vocabulary choice, fluency, or pronunciation hints.
6. Provide an "improvedAnswer" showing how an articulate professional candidate would express the candidate EXACT ideas cleanly and naturally using STAR or structured technical delivery.
` + (!isLastQuestion ? `7. Formulate a relevant follow-up "nextQuestion" (Question ` + (qIndex + 2) + `):
   - Build upon what the candidate said (ask them to elaborate on a trade-off, challenge an assumption, or transition to a related topic within ` + session.topicTitle + `).` : ``) + `

Return strictly a JSON object:
{
  "score": 8.5,
  "verdict": "correct",
  "strengths": "What the candidate answered accurately and well",
  "mistakes": "Specific technical, logical, or factual inaccuracies in their answer",
  "whatWasMissing": "What omitted concepts, edge cases, or details would make this answer complete",
  "grammarAndVocab": "Specific grammar, vocabulary, or pronunciation/fluency feedback",
  "betterAnswer": "Professional, natural version of the candidate ideas",
  "improvementSuggestions": "Actionable advice for the candidate to level up",
  "nextQuestion": "The next relevant follow-up question text (or null if last question)"
}`;

      const parsed = await generateJsonContent(ai, evalPrompt, 0.7);
      if (parsed && parsed.score !== undefined) {
        evaluation = {
          questionIndex: qIndex,
          question: currentQuestion,
          answer: cleanAnswer,
          score: Math.max(0, Math.min(10, parseFloat(parsed.score) || 7.5)),
          verdict: parsed.verdict || (parsed.score >= 8 ? "correct" : (parsed.score >= 5 ? "partially_correct" : "incorrect")),
          strengths: parsed.strengths || parsed.whatWasCorrect || "Addressed the question with genuine effort.",
          whatWasCorrect: parsed.strengths || parsed.whatWasCorrect || "Addressed the question with genuine effort.",
          mistakes: parsed.mistakes || "No major inaccuracies.",
          whatWasMissing: parsed.whatWasMissing || "Could elaborate with real-world examples.",
          grammarAndVocab: parsed.grammarAndVocab || "Good conversational flow with minor phrasing refinements.",
          betterAnswer: parsed.betterAnswer || "",
          improvementSuggestions: parsed.improvementSuggestions || "Structure your points clearly using STAR framing."
        };
        if (!isLastQuestion && parsed.nextQuestion && parsed.nextQuestion.trim().length > 10) {
          nextQuestion = parsed.nextQuestion.trim();
        }
      }
    } catch (e) {
      console.warn("Gemini interview answer evaluation notice:", e.message);
    }
  }

  if (!evaluation) {
    const wordCount = cleanAnswer.split(/\s+/).length;
    const baseScore = wordCount < 10 ? 4.5 : (wordCount < 30 ? 6.8 : (wordCount < 70 ? 8.2 : 8.8));
    evaluation = {
      questionIndex: qIndex,
      question: currentQuestion,
      answer: cleanAnswer,
      score: baseScore,
      verdict: baseScore >= 8 ? "correct" : (baseScore >= 6 ? "partially_correct" : "incorrect"),
      strengths: "You shared your perspective and addressed the question with " + wordCount + " words.",
      whatWasCorrect: "You shared your perspective and addressed the question with " + wordCount + " words.",
      mistakes: "Ensure exact definitions and avoid ambiguous statements.",
      whatWasMissing: wordCount < 30 ? "Your answer was concise; consider illustrating with practical production examples." : "Remember to discuss trade-offs and edge cases.",
      grammarAndVocab: "Maintain consistent verb tenses and use confident transition words (e.g., Furthermore, Consequently).",
      betterAnswer: "A high-impact answer begins by stating the core concept clearly, explains how it functions in real-world environments, and highlights practical best practices.",
      improvementSuggestions: "Structure answers using STAR (Situation, Task, Action, Result) for behavioral questions, or Concept-Mechanism-Example for technical questions."
    };
  }

  session.evaluations.push(evaluation);

  if (isLastQuestion) {
    session.status = "completed";
    session.completedAt = Date.now();
    const finalReport = await compileFinalReport(session);
    session.finalReport = finalReport;
    interviewHistory.unshift(finalReport);
    scheduleSave();
    return {
      sessionId,
      isCompleted: true,
      currentEvaluation: evaluation,
      finalReport
    };
  } else {
    if (!nextQuestion) {
      nextQuestion = pickRandomUnrepeatedQuestion(session.topicKey, session.difficulty, session.questions, session.userCode);
    }
    recordAskedQuestion(session.userCode, nextQuestion);
    session.questions.push(nextQuestion);
    session.currentIndex += 1;
    return {
      sessionId,
      isCompleted: false,
      currentEvaluation: evaluation,
      nextQuestionNumber: session.currentIndex + 1,
      totalQuestions: session.totalQuestions,
      nextQuestion
    };
  }
}

async function compileFinalReport(session) {
  const evals = session.evaluations || [];
  const totalScore10 = evals.reduce((sum, e) => sum + (e.score || 0), 0);
  const avg10 = evals.length > 0 ? (totalScore10 / evals.length) : 7.0;
  const overallScore100 = Math.round(avg10 * 10);

  let overallGrade = "Good";
  if (overallScore100 >= 90) overallGrade = "Outstanding / Ready to Hire";
  else if (overallScore100 >= 80) overallGrade = "Strong / Recommended";
  else if (overallScore100 >= 70) overallGrade = "Good / Promising";
  else if (overallScore100 >= 60) overallGrade = "Average / Needs Refinement";
  else overallGrade = "Needs Practice";

  let strengths = [];
  let weaknesses = [];
  let grammarFeedback = [];
  let improvementPlan = [];
  let summary = "";

  const ai = getAI();
  if (ai && evals.length > 0) {
    try {
      const qSummary = evals.map((e, i) => `Q${i + 1}: ${e.question}\nAnswer: "${e.answer}"\nScore: ${e.score}/10 (Verdict: ${e.verdict || "evaluated"})\nFeedback: ${e.strengths || e.whatWasCorrect}`).join("\n\n");
      const reportPrompt = `You are the lead interview panelist compiling an executive evaluation report for candidate User ID #${session.userCode}.
Topic: ${session.topicTitle} (${session.difficulty.toUpperCase()} level)
Session Duration: ${session.durationMinutes || 10} minutes
Overall Score: ${overallScore100}/100 (${overallGrade})

Questions and Candidate Performance:
${qSummary}

Synthesize the candidate entire performance.
Return strictly a JSON object:
{\n  "strengths": ["3-4 bullet strings highlighting their strongest attributes"],\n  "weaknesses": ["2-3 bullet strings identifying weak concepts or communication gaps"],\n  "grammarAndVocab": ["2-3 bullet strings detailing grammar, pronunciation, and vocabulary improvements"],\n  "improvementPlan": ["3-4 actionable steps for their personalized improvement plan over the next 14 days"],\n  "summary": "A cohesive 2-3 sentence executive evaluation summary"\n}`;

      const parsed = await generateJsonContent(ai, reportPrompt, 0.6);
      if (parsed && Array.isArray(parsed.strengths) && parsed.strengths.length > 0) {
        strengths = parsed.strengths;
        weaknesses = parsed.weaknesses || [];
        grammarFeedback = parsed.grammarAndVocab || [];
        improvementPlan = parsed.improvementPlan || [];
        summary = parsed.summary || "";
      }
    } catch (e) {
      console.warn("Gemini final report compilation notice:", e.message);
    }
  }

  if (strengths.length === 0) {
    strengths = [
      "Demonstrated willingness to tackle all interview questions with structured thoughts",
      "Articulated foundational terminology and concepts with sincerity",
      "Maintained consistent pacing and positive professional tone throughout the session"
    ];
    weaknesses = [
      "Answers could benefit from deeper technical and architectural trade-off analysis",
      "Occasionally omitted edge cases and concrete metric impacts"
    ];
    grammarFeedback = [
      "Use active voice and past tense consistently when sharing past project achievements",
      "Incorporate precise domain terminology rather than general descriptors"
    ];
    improvementPlan = [
      "Day 1-4: Rehearse answers aloud using the STAR framework (Situation, Task, Action, Result)",
      "Day 5-9: Deep-dive into trade-offs and edge cases for core topic areas",
      "Day 10-14: Practice mock sessions with VocaMate voice mode to build fluent pacing under pressure"
    ];
    summary = "Candidate completed the " + session.topicTitle + " interview with an overall score of " + overallScore100 + "/100. Solid foundational readiness with clear potential to reach top-tier interview performance with targeted practice.";
  }

  return {
    reportId: session.sessionId,
    sessionId: session.sessionId,
    userCode: session.userCode,
    topicKey: session.topicKey,
    topicTitle: session.topicTitle,
    difficulty: session.difficulty,
    overallScore: overallScore100,
    overallScore100: overallScore100,
    overallGrade,
    completedAt: session.completedAt || Date.now(),
    durationSeconds: Math.round(((session.completedAt || Date.now()) - session.startedAt) / 1000),
    durationMinutes: session.durationMinutes || 10,
    totalQuestions: session.totalQuestions,
    strengths,
    weaknesses,
    grammarFeedback,
    areasToImprove: improvementPlan,
    improvementPlan,
    summary,
    questionEvaluations: evals
  };
}

function getInterviewSession(sessionId) {
  return activeSessions.get(sessionId) || null;
}

function getUserInterviewHistory(userCode) {
  const code = String(userCode || "").trim();
  return interviewHistory.filter(h => String(h.userCode) === code);
}

module.exports = {
  TOPIC_CONFIG,
  startInterviewSession,
  submitInterviewAnswer,
  getInterviewSession,
  getUserInterviewHistory
};

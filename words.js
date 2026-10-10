// ============================================================
// words.js — Saved Words & Spaced-Repetition Flashcard Engine
// Persistent storage in vocamate-saved-words.json
// Supports: Word lookup (Definition, Hindi, Pronunciation, Example),
// Periodic Flashcard Recall testing, Mastery tracking
// ============================================================
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const WORDS_STORAGE_FILE = path.join(__dirname, 'vocamate-saved-words.json');
const TMP_FILE = WORDS_STORAGE_FILE + '.tmp';

let wordsData = {
  wordsByUser: {} // userCode -> Array of word objects
};

let geminiClient = null;
function getAI() {
  if (geminiClient) return geminiClient;
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    geminiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
    });
    return geminiClient;
  } catch (e) {
    return null;
  }
}

// Curated built-in fallback dictionary for instant zero-latency lookup
const BUILTIN_VOCAB = {
  eloquent: {
    partOfSpeech: 'adjective',
    pronunciation: '/ˈɛl.ə.kwənt/',
    definition: 'Fluent or persuasive in speaking or writing.',
    hindiMeaning: 'सुवक्ता / प्रभावशाली और सुस्पष्ट बोलने वाला',
    example: 'An eloquent speaker can inspire an entire auditorium with clear and moving language.'
  },
  resilient: {
    partOfSpeech: 'adjective',
    pronunciation: '/rɪˈzɪl.jənt/',
    definition: 'Able to withstand or recover quickly from difficult conditions.',
    hindiMeaning: 'लचीला / विपरीत परिस्थितियों से तुरंत उबरने वाला',
    example: 'Engineers must build resilient software systems that gracefully recover from network failures.'
  },
  meticulous: {
    partOfSpeech: 'adjective',
    pronunciation: '/məˈtɪk.jʊ.ləs/',
    definition: 'Showing great attention to detail; very careful and precise.',
    hindiMeaning: 'अति सावधान / बारीकियों का विशेष ध्यान रखने वाला',
    example: 'Code reviews require meticulous attention to edge cases and memory leaks.'
  },
  pragmatic: {
    partOfSpeech: 'adjective',
    pronunciation: '/præɡˈmæt.ɪk/',
    definition: 'Dealing with things sensibly and realistically in a practical way.',
    hindiMeaning: 'व्यावहारिक / यथार्थवादी',
    example: 'A pragmatic developer chooses the simplest working solution over unnecessary over-engineering.'
  },
  ambiguous: {
    partOfSpeech: 'adjective',
    pronunciation: '/æmˈbɪɡ.ju.əs/',
    definition: 'Open to more than one interpretation; unclear or having a double meaning.',
    hindiMeaning: 'अस्पष्ट / अनेकार्थी',
    example: 'Avoid ambiguous variable names like data or temp in large production codebases.'
  },
  ubiquitous: {
    partOfSpeech: 'adjective',
    pronunciation: '/juːˈbɪk.wɪ.təs/',
    definition: 'Present, appearing, or found everywhere.',
    hindiMeaning: 'सर्वव्यापी / हर जगह मौजूद',
    example: 'Smartphones and cloud APIs have become ubiquitous in modern society.'
  },
  articulate: {
    partOfSpeech: 'verb / adjective',
    pronunciation: '/ɑːˈtɪk.jʊ.lət/',
    definition: 'Having or showing the ability to speak fluently and coherently.',
    hindiMeaning: 'साफ़-साफ़ व्यक्त करना / सुस्पष्ट',
    example: 'She was able to articulate complex database architecture to non-technical stakeholders.'
  },
  collaborate: {
    partOfSpeech: 'verb',
    pronunciation: '/kəˈlæb.ə.reɪt/',
    definition: 'Work jointly on an activity or project towards a shared goal.',
    hindiMeaning: 'सहयोग करना / मिलकर काम करना',
    example: 'Product managers and developers must collaborate closely during agile sprints.'
  },
  lucid: {
    partOfSpeech: 'adjective',
    pronunciation: '/ˈluː.sɪd/',
    definition: 'Expressed clearly; easy to understand; rational.',
    hindiMeaning: 'सुस्पष्ट / समझने में आसान',
    example: 'The senior architect provided a lucid explanation of microservices migration.'
  },
  innovative: {
    partOfSpeech: 'adjective',
    pronunciation: '/ˈɪn.ə.veɪ.tɪv/',
    definition: 'Featuring new methods; advanced and original in thinking.',
    hindiMeaning: 'नवीन / नया तरीका खोजने वाला',
    example: 'Startups thrive by proposing innovative approaches to legacy industry bottlenecks.'
  }
};

function loadWordsData() {
  try {
    if (fs.existsSync(WORDS_STORAGE_FILE)) {
      const raw = fs.readFileSync(WORDS_STORAGE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      wordsData = {
        wordsByUser: parsed.wordsByUser || {}
      };
      return;
    }
  } catch (e) {
    console.warn('Could not load saved words store:', e.message);
  }
  wordsData = { wordsByUser: {} };
  saveWordsData();
}

function saveWordsData() {
  try {
    const payload = JSON.stringify(wordsData, null, 2);
    fs.writeFileSync(TMP_FILE, payload, 'utf8');
    fs.renameSync(TMP_FILE, WORDS_STORAGE_FILE);
  } catch (e) {
    console.error('Error saving words store:', e.message);
  }
}

loadWordsData();

async function lookupWordDefinition(rawWord) {
  const clean = String(rawWord || '').trim().toLowerCase().replace(/[^a-z-]/gi, '');
  if (!clean) return null;

  // Check built-in dictionary first
  if (BUILTIN_VOCAB[clean]) {
    return {
      word: clean,
      ...BUILTIN_VOCAB[clean]
    };
  }

  // Try Gemini AI lookup
  const ai = getAI();
  if (ai) {
    try {
      const prompt = `You are an expert English-to-Hindi lexicographer and language teacher.
Define the English word: "${clean}".
Return strictly a valid JSON object matching this schema:
{
  "word": "${clean}",
  "partOfSpeech": "noun, verb, adjective, or adverb",
  "pronunciation": "standard IPA pronunciation e.g. /ˈwɜːrd/",
  "definition": "Clear, simple 1-sentence English definition suitable for learners",
  "hindiMeaning": "Accurate Hindi meaning in Devanagari script with simple explanation",
  "example": "A natural, conversational 1-sentence example showing practical everyday usage"
}`;

      const res = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.3
        }
      });

      if (res && res.text) {
        const parsed = JSON.parse(res.text.trim());
        if (parsed.definition) {
          return {
            word: clean,
            partOfSpeech: parsed.partOfSpeech || 'noun',
            pronunciation: parsed.pronunciation || `/${clean}/`,
            definition: parsed.definition,
            hindiMeaning: parsed.hindiMeaning || '',
            example: parsed.example || `The word "${clean}" is used in spoken English.`
          };
        }
      }
    } catch (e) {
      console.warn('Gemini word lookup notice:', e.message);
    }
  }

  // Fallback heuristic definition
  return {
    word: clean,
    partOfSpeech: 'word',
    pronunciation: `/${clean}/`,
    definition: `A term used in English conversation and formal discourse.`,
    hindiMeaning: `अंग्रेजी शब्द: ${clean}`,
    example: `Please practice using "${clean}" in your everyday speaking sentences.`
  };
}

async function saveWord({ userCode, word, context = '', customDefinition = null }) {
  const code = String(userCode || 'default').trim();
  const cleanWord = String(word || '').trim().toLowerCase().replace(/[^a-z-]/gi, '');
  if (!cleanWord || cleanWord.length < 2) throw new Error('Please specify a valid English word');

  if (!wordsData.wordsByUser[code]) {
    wordsData.wordsByUser[code] = [];
  }

  const list = wordsData.wordsByUser[code];
  const existingIdx = list.findIndex(w => w.word.toLowerCase() === cleanWord);

  let details = customDefinition;
  if (!details) {
    details = await lookupWordDefinition(cleanWord);
  }

  const now = Date.now();
  if (existingIdx !== -1) {
    // Update existing word
    const existing = list[existingIdx];
    existing.context = context || existing.context;
    existing.updatedAt = now;
    if (details) {
      existing.definition = details.definition || existing.definition;
      existing.hindiMeaning = details.hindiMeaning || existing.hindiMeaning;
      existing.example = details.example || existing.example;
      existing.partOfSpeech = details.partOfSpeech || existing.partOfSpeech;
      existing.pronunciation = details.pronunciation || existing.pronunciation;
    }
    saveWordsData();
    return { word: existing, isNew: false };
  }

  const wordEntry = {
    id: `w_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`,
    word: cleanWord,
    partOfSpeech: (details && details.partOfSpeech) || 'word',
    pronunciation: (details && details.pronunciation) || `/${cleanWord}/`,
    definition: (details && details.definition) || `English vocabulary term.`,
    hindiMeaning: (details && details.hindiMeaning) || '',
    example: (details && details.example) || `Try speaking a sentence with "${cleanWord}".`,
    context: context || 'Saved from AI Chat practice',
    mastery: 'learning', // 'learning' | 'mastered'
    reviewCount: 0,
    successfulRecalls: 0,
    lastReviewedAt: null,
    savedAt: now,
    updatedAt: now
  };

  list.unshift(wordEntry);
  saveWordsData();
  return { word: wordEntry, isNew: true };
}

function getSavedWords(userCode, filter = 'all') {
  const code = String(userCode || 'default').trim();
  const list = wordsData.wordsByUser[code] || [];

  let filtered = [...list];
  if (filter === 'learning') {
    filtered = filtered.filter(w => w.mastery === 'learning');
  } else if (filter === 'mastered') {
    filtered = filtered.filter(w => w.mastery === 'mastered');
  }

  const total = list.length;
  const mastered = list.filter(w => w.mastery === 'mastered').length;
  const learning = total - mastered;
  const masteryPercentage = total > 0 ? Math.round((mastered / total) * 100) : 0;

  return {
    words: filtered,
    stats: {
      total,
      mastered,
      learning,
      masteryPercentage
    }
  };
}

function reviewWord(userCode, wordId, recalled = true) {
  const code = String(userCode || 'default').trim();
  const list = wordsData.wordsByUser[code] || [];
  const entry = list.find(w => w.id === wordId);
  if (!entry) throw new Error('Word not found in your saved list');

  entry.reviewCount = (entry.reviewCount || 0) + 1;
  entry.lastReviewedAt = Date.now();

  if (recalled) {
    entry.successfulRecalls = (entry.successfulRecalls || 0) + 1;
    if (entry.successfulRecalls >= 2) {
      entry.mastery = 'mastered';
    }
  } else {
    entry.successfulRecalls = Math.max(0, (entry.successfulRecalls || 0) - 1);
    entry.mastery = 'learning';
  }

  saveWordsData();
  return entry;
}

function deleteWord(userCode, wordId) {
  const code = String(userCode || 'default').trim();
  const list = wordsData.wordsByUser[code] || [];
  const idx = list.findIndex(w => w.id === wordId);
  if (idx === -1) throw new Error('Word not found');

  const deleted = list.splice(idx, 1)[0];
  saveWordsData();
  return deleted;
}

function getFlashcardDeck(userCode, limit = 15) {
  const code = String(userCode || 'default').trim();
  const list = wordsData.wordsByUser[code] || [];
  if (list.length === 0) return [];

  // Prioritize words that are still in 'learning' mode, then by oldest lastReviewedAt
  const sorted = [...list].sort((a, b) => {
    if (a.mastery !== b.mastery) {
      return a.mastery === 'learning' ? -1 : 1;
    }
    return (a.lastReviewedAt || 0) - (b.lastReviewedAt || 0);
  });

  return sorted.slice(0, limit);
}

module.exports = {
  saveWord,
  getSavedWords,
  reviewWord,
  deleteWord,
  getFlashcardDeck,
  lookupWordDefinition
};

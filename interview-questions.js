// ============================================================
// interview-questions.js — Comprehensive Interview Question Bank
// Persistent storage in vocamate-interview-questions.json
// Supports Admin CRUD (Add, Edit, Delete) & Dynamic Loading into AI Interview
// ============================================================
const fs = require('fs');
const path = require('path');

const QUESTIONS_FILE = path.join(__dirname, 'vocamate-interview-questions.json');
const TMP_FILE = QUESTIONS_FILE + '.tmp';

let questionBank = [];

// Seed extensive high-yield interview questions
const SEED_QUESTIONS = [
  // ==========================================================
  // 1. JAVA INTERVIEW
  // ==========================================================
  // Beginner
  {
    id: 'java_b_1',
    topic: 'java',
    difficulty: 'beginner',
    question: 'What are the core Object-Oriented Programming (OOP) principles in Java, and how does Java implement them?',
    expectedAnswer: 'Encapsulation (getters/setters, access modifiers), Inheritance (extends keyword), Polymorphism (overloading and overriding), and Abstraction (abstract classes and interfaces).',
    keyPoints: ['Encapsulation', 'Inheritance', 'Polymorphism', 'Abstraction', 'Access modifiers']
  },
  {
    id: 'java_b_2',
    topic: 'java',
    difficulty: 'beginner',
    question: 'What is the difference between JDK, JRE, and JVM in Java?',
    expectedAnswer: 'JDK (Java Development Kit) contains tools for developing Java programs (javac, debugger). JRE (Java Runtime Environment) contains libraries and JVM to run compiled bytecode. JVM (Java Virtual Machine) executes bytecode into machine code.',
    keyPoints: ['JDK contains compiler and development tools', 'JRE contains runtime libraries', 'JVM executes bytecode on the OS']
  },
  {
    id: 'java_b_3',
    topic: 'java',
    difficulty: 'beginner',
    question: 'What is the difference between `==` and `.equals()` method when comparing objects in Java?',
    expectedAnswer: '`==` compares memory references (addresses) of two objects, while `.equals()` compares logical content equality (can be overridden by classes like String).',
    keyPoints: ['== checks reference equality', '.equals() checks value equality', 'String overrides equals()']
  },
  {
    id: 'java_b_4',
    topic: 'java',
    difficulty: 'beginner',
    question: 'Why is String immutable in Java, and what are the benefits of string immutability?',
    expectedAnswer: 'Strings are immutable for security (parameters, class loading), caching (String Constant Pool saves memory), thread safety (safe across threads without synchronization), and hashcode caching in HashMaps.',
    keyPoints: ['String Constant Pool', 'Security', 'Thread safety', 'HashCode caching']
  },
  {
    id: 'java_b_5',
    topic: 'java',
    difficulty: 'beginner',
    question: 'What is the difference between `ArrayList` and `LinkedList` in Java Collections Framework?',
    expectedAnswer: 'ArrayList is backed by a dynamic resizing array providing O(1) random access by index, but O(n) insertions/deletions in middle. LinkedList is a doubly-linked list with O(1) insertions/deletions if pointer is known, but O(n) traversal.',
    keyPoints: ['Dynamic array vs Doubly-linked list', 'Random access O(1) vs O(n)', 'Memory overhead of pointers in LinkedList']
  },
  {
    id: 'java_b_6',
    topic: 'java',
    difficulty: 'beginner',
    question: 'What is the purpose of the `static` keyword in Java?',
    expectedAnswer: 'The static keyword belongs to the class itself rather than individual instances. Static variables share one copy across all objects; static methods can be called without instantiating an object.',
    keyPoints: ['Belongs to class level', 'Shared across instances', 'Loaded at class initialization', 'Static methods cannot access non-static variables directly']
  },
  {
    id: 'java_b_7',
    topic: 'java',
    difficulty: 'beginner',
    question: 'What are the differences between checked and unchecked exceptions in Java?',
    expectedAnswer: 'Checked exceptions inherit from Exception (excluding RuntimeException) and must be handled at compile-time (try-catch or throws, e.g. IOException, SQLException). Unchecked exceptions inherit from RuntimeException and occur at runtime (e.g. NullPointerException, ArithmeticException).',
    keyPoints: ['Checked: checked at compile-time', 'Unchecked: subclasses of RuntimeException', 'Error handling strategies']
  },

  // Java Intermediate
  {
    id: 'java_i_1',
    topic: 'java',
    difficulty: 'intermediate',
    question: 'How does HashMap work internally in Java 8+? What happens during a hash collision?',
    expectedAnswer: 'HashMap uses an array of Node (bucket array) with default capacity 16 and load factor 0.75. When put() is called, hashCode() is calculated, hashed, and modulo array length gives bucket index. On collision, entries are stored in a linked list; if the list reaches TREEIFY_THRESHOLD (8 entries) and table capacity >= 64, it converts to a Red-Black Tree (O(log n) lookup).',
    keyPoints: ['Array of buckets', 'hashCode() & equals() contract', 'LinkedList to Red-Black Tree at 8 items', 'Treeify threshold', 'O(1) to O(log n)']
  },
  {
    id: 'java_i_2',
    topic: 'java',
    difficulty: 'intermediate',
    question: 'Explain the Java Memory Model and the purpose of the `volatile` keyword in multithreading.',
    expectedAnswer: 'Java assigns heap memory shared across threads, and thread-local CPU cache memory. The `volatile` keyword guarantees visibility: reads and writes bypass CPU registers/caches and go directly to main memory, preventing stale reads. It also establishes a happens-before relationship and prevents instruction reordering.',
    keyPoints: ['Main memory vs CPU cache', 'Visibility guarantee', 'Happens-before guarantee', 'Does not provide mutual exclusion/atomicity (like synchronized)']
  },
  {
    id: 'java_i_3',
    topic: 'java',
    difficulty: 'intermediate',
    question: 'What is the difference between `synchronized` block and `ReentrantLock` in Java Concurrency?',
    expectedAnswer: 'synchronized is an intrinsic language-level lock (automatic release, non-interruptible, no timeout). ReentrantLock (java.util.concurrent.locks) is an explicit lock providing fairness policies, tryLock() with timeout, lockInterruptibly(), and multiple Condition variables.',
    keyPoints: ['Intrinsic vs Explicit', 'tryLock() with timeouts', 'Fair vs non-fair locking', 'Condition objects for signaling']
  },
  {
    id: 'java_i_4',
    topic: 'java',
    difficulty: 'intermediate',
    question: 'How does Garbage Collection work in modern Java (e.g. G1GC), and what are Generational Garbage Collection zones?',
    expectedAnswer: 'JVM divides heap into Young Generation (Eden, Survivor S0, S1) and Old (Tenured) Generation. New objects allocate in Eden; survivors of Minor GC move to Survivor spaces and age until threshold (tenuring threshold) to reach Old Gen. G1GC divides heap into equal regions and prioritizes collecting regions with the most garbage first.',
    keyPoints: ['Young Gen (Eden, S0, S1)', 'Old / Tenured Gen', 'Metaspace', 'Stop-the-world pauses', 'G1GC region-based collection']
  },
  {
    id: 'java_i_5',
    topic: 'java',
    difficulty: 'intermediate',
    question: 'What are Java Functional Interfaces and Lambda Expressions introduced in Java 8?',
    expectedAnswer: 'A Functional Interface has exactly one abstract method (annotated with @FunctionalInterface, e.g. Predicate, Consumer, Function, Supplier). Lambda expressions provide concise implementations without anonymous inner classes, enabling declarative Stream API pipelines.',
    keyPoints: ['Single Abstract Method (SAM)', '@FunctionalInterface', 'Stream API integration', 'Predicate, Function, Consumer, Supplier']
  },
  {
    id: 'java_i_6',
    topic: 'java',
    difficulty: 'intermediate',
    question: 'What is the difference between fail-fast and fail-safe iterators in Java?',
    expectedAnswer: 'Fail-fast iterators (like ArrayList, HashMap) throw ConcurrentModificationException immediately if the collection is structurally modified during iteration (via modCount). Fail-safe/fail-tolerant iterators (like CopyOnWriteArrayList, ConcurrentHashMap) operate on a clone or snapshot without throwing exceptions.',
    keyPoints: ['modCount check', 'ConcurrentModificationException', 'CopyOnWrite snapshot iteration', 'java.util vs java.util.concurrent']
  },

  // Java Advanced
  {
    id: 'java_a_1',
    topic: 'java',
    difficulty: 'advanced',
    question: 'How do Virtual Threads (Project Loom) in Java 21 differ from platform OS threads, and how do they scale high-throughput I/O?',
    expectedAnswer: 'Platform threads are 1:1 mapped to OS kernel threads, consuming ~1MB stack and incurring expensive context switches. Virtual threads are lightweight user-mode threads managed by JVM (M:N mapped to carrier threads). When a virtual thread blocks on blocking I/O (network/socket), JVM unmounts it from the carrier thread, allowing millions of concurrent tasks with synchronous, blocking-style code.',
    keyPoints: ['1:1 OS threads vs M:N lightweight virtual threads', 'Carrier thread mounting/unmounting', 'Low memory footprint (few KB)', 'No need for complex reactive callback code']
  },
  {
    id: 'java_a_2',
    topic: 'java',
    difficulty: 'advanced',
    question: 'How would you diagnose and resolve a memory leak or OutOfMemoryError (OOM: Java heap space) in a live production service?',
    expectedAnswer: '1) Capture heap dump on OOM (-XX:+HeapDumpOnOutOfMemoryError). 2) Analyze heap dump with Eclipse MAT or VisualVM to find dominant dominator trees and retained heap. 3) Inspect common culprits: unclosed resources, static collections, lingering ThreadLocal variables, or unbounded caches. 4) Profile live GC activity with GC logs (-Xlog:gc*) to monitor pause times.',
    keyPoints: ['Heap dump capture (.hprof)', 'Eclipse MAT dominator tree', 'Static collection leaks', 'ThreadLocal leaks in thread pools', 'GC logging']
  },
  {
    id: 'java_a_3',
    topic: 'java',
    difficulty: 'advanced',
    question: 'Explain how ClassLoaders work in Java, parent delegation model, and how to break delegation for plugin architectures.',
    expectedAnswer: 'Java uses a hierarchy: Bootstrap ClassLoader -> Platform/Extension ClassLoader -> Application (System) ClassLoader. When loading a class, a ClassLoader first delegates to its parent; only if parent cannot find it does it load locally. OSGi and web servlet containers break this model (child-first) to allow independent versions of libraries in isolated modules.',
    keyPoints: ['Parent delegation model', 'Bootstrap, Platform, System ClassLoaders', 'loadClass vs findClass', 'Breaking delegation for hot-reloading/plugins']
  },

  // ==========================================================
  // 2. DATA STRUCTURES & ALGORITHMS (DSA)
  // ==========================================================
  // Beginner
  {
    id: 'dsa_b_1',
    topic: 'dsa',
    difficulty: 'beginner',
    question: 'What is Time Complexity and Space Complexity? Can you explain Big O notation with examples of O(1), O(n), and O(n²)?',
    expectedAnswer: 'Big O represents the upper bound asymptotic behavior of an algorithm as input size n grows. O(1) is constant time (accessing array by index). O(n) is linear time (finding maximum in unsorted array). O(n²) is quadratic time (nested loops like bubble sort).',
    keyPoints: ['Asymptotic upper bound', 'O(1) constant', 'O(n) linear loop', 'O(n²) nested loop', 'Worst-case performance']
  },
  {
    id: 'dsa_b_2',
    topic: 'dsa',
    difficulty: 'beginner',
    question: 'How do you detect a cycle in a Singly Linked List? Explain Floyd\'s Cycle Detection (Tortoise and Hare) algorithm.',
    expectedAnswer: 'Use two pointers: slow pointer moves 1 step at a time, fast pointer moves 2 steps. If there is a cycle, fast will eventually catch up and meet slow (O(n) time, O(1) space). If fast reaches null, no cycle exists.',
    keyPoints: ['Slow and fast pointers', '2 steps vs 1 step', 'O(n) time complexity', 'O(1) auxiliary space']
  },
  {
    id: 'dsa_b_3',
    topic: 'dsa',
    difficulty: 'beginner',
    question: 'Explain the difference between a Stack (LIFO) and a Queue (FIFO), and describe practical applications for each.',
    expectedAnswer: 'Stack is Last-In-First-Out (push/pop at top; used for function call stacks, undo operations, parenthesis matching). Queue is First-In-First-Out (enqueue at rear, dequeue at front; used for printer queues, BFS traversal, request buffering).',
    keyPoints: ['LIFO vs FIFO', 'Stack applications (undo, recursion)', 'Queue applications (BFS, job scheduling)']
  },
  {
    id: 'dsa_b_4',
    topic: 'dsa',
    difficulty: 'beginner',
    question: 'How does Binary Search work, and what is its precondition and time complexity?',
    expectedAnswer: 'Precondition: Array must be sorted. It compares the target with the middle element; if target is smaller, searches left half; if larger, searches right half. Halves search space each step, achieving O(log n) time and O(1) space.',
    keyPoints: ['Requires sorted array', 'Divide and conquer', 'O(log n) time complexity', 'Mid calculation avoiding integer overflow: mid = low + (high - low)/2']
  },

  // DSA Intermediate
  {
    id: 'dsa_i_1',
    topic: 'dsa',
    difficulty: 'intermediate',
    question: 'How would you solve the Two Sum and Three Sum problems efficiently? Compare brute-force versus optimal approaches.',
    expectedAnswer: 'Two Sum: Brute force is O(n²). Optimal is O(n) using a HashMap storing {value: index} to check for complement (target - num) in O(1). Three Sum: Sort array (O(n log n)), iterate i from 0 to n-3, and use two pointers (left, right) for remaining two elements with duplicate skipping for O(n²) time and O(1) extra space.',
    keyPoints: ['HashMap complement lookup O(n)', 'Sorting + Two pointers for 3Sum O(n²)', 'Skipping duplicates to prevent duplicate triplets']
  },
  {
    id: 'dsa_i_2',
    topic: 'dsa',
    difficulty: 'intermediate',
    question: 'What is the Sliding Window technique, and how do you find the Longest Substring Without Repeating Characters?',
    expectedAnswer: 'Sliding Window maintains a window [left, right] that expands right and shrinks left when constraints are violated. For unique characters, use a Map or array of last seen indices. As right moves, if char was seen inside current window, jump left to lastSeen[char] + 1. Update max length = max(max, right - left + 1) in O(n) time.',
    keyPoints: ['Window pointers [left, right]', 'Shrinking condition on duplicate', 'O(n) time with Map/Set', 'O(min(n, m)) space']
  },
  {
    id: 'dsa_i_3',
    topic: 'dsa',
    difficulty: 'intermediate',
    question: 'What are Binary Search Trees (BST), and what is the difference between Breadth-First Search (BFS) and Depth-First Search (DFS) in trees?',
    expectedAnswer: 'In a BST, every left child < node < right child. Inorder traversal yields sorted order. BFS (Level-Order) visits nodes level by level using a Queue (O(w) space). DFS explores branches to depth using a Stack or recursion (Preorder, Inorder, Postorder; O(h) space).',
    keyPoints: ['BST property', 'Inorder traversal gives sorted order', 'BFS uses Queue for levels', 'DFS uses recursion/stack', 'Time O(n) for both']
  },
  {
    id: 'dsa_i_4',
    topic: 'dsa',
    difficulty: 'intermediate',
    question: 'How does a Min-Heap / Max-Heap work, and how is it used to find the Kth Largest Element in an Array?',
    expectedAnswer: 'A Heap is a complete binary tree where parent is <= children (Min-Heap) or >= children (Max-Heap), stored in an array (parent at i, children at 2i+1, 2i+2). To find Kth largest, maintain a Min-Heap of size K. For each element, push; if size > K, pop minimum. At the end, root of heap is Kth largest in O(n log k) time and O(k) space.',
    keyPoints: ['Complete binary tree array representation', 'O(log k) insert/delete', 'Maintain Min-Heap of size K', 'O(n log k) time better than O(n log n) full sort']
  },

  // DSA Advanced
  {
    id: 'dsa_a_1',
    topic: 'dsa',
    difficulty: 'advanced',
    question: 'Explain Dynamic Programming (DP) and how you determine whether a problem requires Memoization (Top-Down) or Tabulation (Bottom-Up) using the 0/1 Knapsack problem.',
    expectedAnswer: 'DP applies to problems with Overlapping Subproblems and Optimal Substructure. 0/1 Knapsack: For each item i with weight w and value v, choose between including it: dp[i][W] = max(dp[i-1][W], dp[i-1][W-w] + v). Top-down uses recursion + cache; bottom-up fills a 2D table or optimized 1D rolling array iterating backwards to prevent reuse of same item in O(n*W) time and O(W) space.',
    keyPoints: ['Optimal Substructure & Overlapping Subproblems', 'State definition dp[i][w]', 'Space optimization to 1D array by iterating right-to-left', 'Pseudo-polynomial time complexity']
  },
  {
    id: 'dsa_a_2',
    topic: 'dsa',
    difficulty: 'advanced',
    question: 'Explain Dijkstra\'s Algorithm for single-source shortest path and how it compares to Bellman-Ford and A* search.',
    expectedAnswer: 'Dijkstra finds shortest paths in graphs with non-negative edge weights using a PriorityQueue (Min-Heap) of {distance, node}. At each step, relaxes outgoing edges of closest unvisited node (O((V + E) log V) time). Bellman-Ford handles negative weights and detects negative cycles (O(V*E)). A* augments Dijkstra with an admissible heuristic function h(n) to prioritize nodes toward target.',
    keyPoints: ['Greedy relaxation with PriorityQueue', 'Non-negative weights constraint', 'Bellman-Ford for negative weights O(V*E)', 'A* heuristic guided search']
  },
  {
    id: 'dsa_a_3',
    topic: 'dsa',
    difficulty: 'advanced',
    question: 'How does a Trie (Prefix Tree) work, and how would you implement an Autocomplete Search System with prefix matching?',
    expectedAnswer: 'A Trie is an n-ary tree where each node represents a character, containing children map/array and isEndOfWord boolean. Inserting and searching words takes O(L) time where L is word length. For autocomplete: traverse to the prefix node, then perform DFS or store precomputed top-K trending words at each node to return instant suggestions in O(1) query time.',
    keyPoints: ['Character branching at each node', 'O(L) insert and lookup', 'Fast prefix matching', 'Top-K precomputing for scale']
  },

  // ==========================================================
  // 3. WEB DEVELOPMENT & FRONTEND
  // ==========================================================
  // Beginner
  {
    id: 'web_b_1',
    topic: 'webdev',
    difficulty: 'beginner',
    question: 'What is the DOM (Document Object Model) and how does JavaScript interact with it?',
    expectedAnswer: 'The DOM is an in-memory tree representation of the HTML document created by the browser. JavaScript uses the DOM API (document.querySelector, addEventListener, innerHTML, classList) to dynamically read, modify styles, add elements, and listen to user interactions.',
    keyPoints: ['Tree of nodes (elements, attributes, text)', 'document.getElementById / querySelector', 'Event listeners', 'Manipulating DOM triggers reflow/repaint']
  },
  {
    id: 'web_b_2',
    topic: 'webdev',
    difficulty: 'beginner',
    question: 'Explain the difference between `var`, `let`, and `const` in modern JavaScript.',
    expectedAnswer: '`var` is function-scoped and hoisted with undefined initialization. `let` and `const` are block-scoped and live in the Temporal Dead Zone (TDZ) before declaration. `const` cannot be reassigned, though object properties can still be mutated.',
    keyPoints: ['Function scope vs Block scope', 'Temporal Dead Zone (TDZ)', 'Reassignment rules', 'Hoisting behavior']
  },
  {
    id: 'web_b_3',
    topic: 'webdev',
    difficulty: 'beginner',
    question: 'What is the CSS Box Model, and what is the difference between `content-box` and `border-box`?',
    expectedAnswer: 'The Box Model consists of Content, Padding, Border, and Margin. With `content-box` (default), width only applies to content (padding/border increase total size). With `border-box`, width includes content + padding + border, making responsive layout calculations intuitive and predictable.',
    keyPoints: ['Content, Padding, Border, Margin', 'box-sizing: border-box', 'Total width calculation']
  },
  {
    id: 'web_b_4',
    topic: 'webdev',
    difficulty: 'beginner',
    question: 'What is the difference between synchronous and asynchronous code in JavaScript? How do Promises work?',
    expectedAnswer: 'Synchronous code executes line-by-line, blocking execution. Asynchronous code offloads long tasks (fetching data, timers) to the browser runtime without blocking. A Promise represents an eventual value in one of three states: Pending, Fulfilled (.then), or Rejected (.catch).',
    keyPoints: ['Non-blocking execution', 'Promise states: Pending, Fulfilled, Rejected', 'async/await syntactic sugar', 'Microtask queue']
  },

  // WebDev Intermediate
  {
    id: 'web_i_1',
    topic: 'webdev',
    difficulty: 'intermediate',
    question: 'Explain the JavaScript Event Loop, Call Stack, Microtask Queue (Promises), and Macrotask Queue (setTimeout).',
    expectedAnswer: 'The Call Stack runs synchronous code. When async APIs finish, callbacks go to queues. Microtasks (Promise.then, MutationObserver, queueMicrotask) have higher priority: after every synchronous frame, the Event Loop drains ALL microtasks before taking ONE task from the Macrotask queue (setTimeout, setInterval, I/O, UI render).',
    keyPoints: ['Single-threaded Call Stack', 'Microtask queue drains before next macrotask', 'setTimeout goes to macrotask queue', 'Promise .then goes to microtask queue']
  },
  {
    id: 'web_i_2',
    topic: 'webdev',
    difficulty: 'intermediate',
    question: 'How does React\'s Virtual DOM and Reconciliation algorithm (Fiber) improve rendering performance?',
    expectedAnswer: 'Direct DOM manipulation is expensive due to layout reflows and repaints. React maintains a lightweight Virtual DOM in JS memory. When state changes, React generates a new Virtual DOM tree, diffs it with the previous tree (Reconciliation using keys and heuristic diffing), and applies minimal batch patches to the real DOM.',
    keyPoints: ['Virtual DOM in memory', 'Diffing algorithm O(n) with keys', 'Batch updates to Real DOM', 'React Fiber interruptible rendering units']
  },
  {
    id: 'web_i_3',
    topic: 'webdev',
    difficulty: 'intermediate',
    question: 'What is a Closure in JavaScript, and what are real-world use cases for closures?',
    expectedAnswer: 'A closure is a function bundled with references to its surrounding lexical environment; it remembers and accesses variables from its outer scope even after the outer function has returned. Use cases: data privacy/encapsulation (private variables), function factories, memoization, and debounce/throttle implementations.',
    keyPoints: ['Lexical scoping', 'Retains outer variables after outer return', 'Private variables/encapsulation', 'Debounce and throttle implementations']
  },
  {
    id: 'web_i_4',
    topic: 'webdev',
    difficulty: 'intermediate',
    question: 'What are CORS (Cross-Origin Resource Sharing), Preflight requests, and how do you resolve CORS errors?',
    expectedAnswer: 'CORS is a browser security mechanism enforcing Same-Origin Policy (protocol, domain, port). For non-simple requests (methods like PUT/DELETE or custom headers), browser sends an OPTIONS preflight request. The server must respond with `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, and `Access-Control-Allow-Headers`.',
    keyPoints: ['Same-Origin Policy', 'OPTIONS preflight request', 'Access-Control-Allow-Origin header', 'Client cannot bypass alone, must be configured on backend/proxy']
  },

  // WebDev Advanced
  {
    id: 'web_a_1',
    topic: 'webdev',
    difficulty: 'advanced',
    question: 'How would you optimize Core Web Vitals (LCP, INP, CLS) for a high-traffic production web application?',
    expectedAnswer: 'LCP (Largest Contentful Paint): preload critical hero assets, use responsive WebP/AVIF images, CDN caching, SSR or static HTML generation. INP (Interaction to Next Paint): break long JS tasks into chunks with requestIdleCallback or Web Workers, debounce event listeners. CLS (Cumulative Layout Shift): set explicit width/height on images and media, reserve space for dynamic ads/fonts (font-display: swap).',
    keyPoints: ['LCP < 2.5s (asset preload, CDN, SSR)', 'INP < 200ms (main thread unblocking, Web Workers)', 'CLS < 0.1 (aspect-ratio, reserved layout dimensions)']
  },
  {
    id: 'web_a_2',
    topic: 'webdev',
    difficulty: 'advanced',
    question: 'Explain the security implications of XSS (Cross-Site Scripting) versus CSRF (Cross-Site Request Forgery) and their modern mitigations.',
    expectedAnswer: 'XSS: Attacker injects malicious JS into the victim\'s browser (Stored, Reflected, DOM-based) to steal tokens. Mitigate with Content Security Policy (CSP), HTML escaping/sanitization, and storing session tokens in httpOnly cookies. CSRF: Attacker tricks authenticated browser into making unauthorized requests. Mitigate with SameSite=Strict cookies, anti-CSRF tokens, and checking Origin/Referer headers.',
    keyPoints: ['XSS executes malicious JS (mitigate: CSP, sanitize, httpOnly cookies)', 'CSRF forges unauthorized requests (mitigate: SameSite cookies, CSRF tokens)', 'httpOnly + secure + SameSite cookie flags']
  },

  // ==========================================================
  // 4. BACKEND & FULL STACK
  // ==========================================================
  // Beginner
  {
    id: 'backend_b_1',
    topic: 'fullstack',
    difficulty: 'beginner',
    question: 'What is RESTful API architecture, and what are the standard HTTP methods and status codes?',
    expectedAnswer: 'REST uses stateless client-server communication with resource-based URIs. Methods: GET (read), POST (create), PUT/PATCH (update), DELETE (remove). Codes: 200 OK, 201 Created, 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 500 Internal Server Error.',
    keyPoints: ['Stateless communication', 'HTTP Verbs: GET, POST, PUT, DELETE', 'Status codes 2xx, 4xx, 5xx', 'JSON representation']
  },
  {
    id: 'backend_b_2',
    topic: 'fullstack',
    difficulty: 'beginner',
    question: 'What is the difference between SQL (Relational) and NoSQL databases? When would you choose one over the other?',
    expectedAnswer: 'SQL (PostgreSQL, MySQL) enforces structured schemas, ACID transactions, and table relations using foreign keys. Ideal for financial, e-commerce, and structured relational data. NoSQL (MongoDB, DynamoDB) provides flexible schema (documents, key-value), horizontal scaling, and rapid iteration for unstructured or high-velocity data.',
    keyPoints: ['Structured tables vs Flexible documents', 'ACID transactions vs Eventual consistency', 'Horizontal scaling vs Vertical scaling', 'Schema enforcement']
  },

  // Backend Intermediate
  {
    id: 'backend_i_1',
    topic: 'fullstack',
    difficulty: 'intermediate',
    question: 'How does database indexing work (B-Tree), and what are the trade-offs of adding too many indexes on a table?',
    expectedAnswer: 'An index is a separate data structure (typically B-Tree) storing column values and row pointers sorted. It transforms O(n) table scans into O(log n) lookups for WHERE, JOIN, and ORDER BY clauses. Trade-offs: every INSERT, UPDATE, and DELETE must update the index trees, slowing down write operations and consuming extra disk/memory.',
    keyPoints: ['B-Tree sorted lookups O(log n)', 'Speeds up SELECT, WHERE, JOIN', 'Slows down INSERT/UPDATE/DELETE', 'Storage overhead']
  },
  {
    id: 'backend_i_2',
    topic: 'fullstack',
    difficulty: 'intermediate',
    question: 'Explain JWT (JSON Web Token) authentication architecture, its structure, and how to securely store and revoke tokens.',
    expectedAnswer: 'JWT has 3 parts: Header (algorithm), Payload (claims/user info), and Signature (HMAC/RSA). Server verifies signature without DB lookup (stateless). Storage: store in httpOnly, Secure, SameSite cookie to prevent XSS. Revocation: use short-lived access tokens (15 mins) and refresh tokens stored in DB/Redis that can be blacklisted on logout.',
    keyPoints: ['Header.Payload.Signature', 'Stateless verification', 'httpOnly cookie storage against XSS', 'Short-lived access token + Refresh token rotation']
  },

  // Backend Advanced
  {
    id: 'backend_a_1',
    topic: 'fullstack',
    difficulty: 'advanced',
    question: 'How would you design a distributed caching layer using Redis to prevent Cache Stampede and Cache Penetration?',
    expectedAnswer: 'Cache Aside pattern: check Redis; on miss, query DB and write to Redis with TTL. Cache Stampede (thousands of requests hit DB simultaneously when key expires): solve using distributed locks (Redis Redlock) or probabilistic early expiration (XFetch). Cache Penetration (queries for non-existent keys hit DB): solve using Bloom filters or caching null values with short TTL.',
    keyPoints: ['Cache-aside pattern', 'Cache Stampede & Distributed Mutex lock', 'Cache Penetration & Bloom filters', 'Cache Avalanche & jittered TTL']
  },

  // ==========================================================
  // 5. HR & BEHAVIORAL INTERVIEWS
  // ==========================================================
  // Beginner
  {
    id: 'hr_b_1',
    topic: 'hr',
    difficulty: 'beginner',
    question: 'Can you tell me about yourself, your educational background, and what inspired you to pursue a career in technology?',
    expectedAnswer: 'Structure using Present-Past-Future: Current focus and technical passion, academic background and formative projects, followed by enthusiasm for this specific role.',
    keyPoints: ['Clear 90-second structure', 'Present skills', 'Past academic achievements', 'Future enthusiasm']
  },
  {
    id: 'hr_b_2',
    topic: 'hr',
    difficulty: 'beginner',
    question: 'Why are you interested in joining our company specifically, rather than another organization?',
    expectedAnswer: 'Reference company\'s actual mission, products, engineering culture, and how personal career goals align with their upcoming initiatives.',
    keyPoints: ['Company mission & culture', 'Specific product impact', 'Mutual growth opportunity']
  },
  {
    id: 'hr_b_3',
    topic: 'hr',
    difficulty: 'beginner',
    question: 'What are your key strengths, and can you share an example of a situation where you demonstrated them?',
    expectedAnswer: 'Highlight 1-2 authentic strengths (e.g. quick learning, persistence, attention to detail) followed by a concrete real-world example.',
    keyPoints: ['Self-awareness', 'Concrete example', 'Humility']
  },

  // HR Intermediate
  {
    id: 'hr_i_1',
    topic: 'hr',
    difficulty: 'intermediate',
    question: 'Describe a situation where you had a disagreement with a team member or manager. How did you resolve it professionally?',
    expectedAnswer: 'Use STAR method: Describe Situation, Task, Action taken (active listening, objective data discussion in private, compromise), and Result (successful project delivery and strengthened relationship).',
    keyPoints: ['STAR technique', 'Focus on resolution not blame', 'Active listening and objective data', 'Positive team outcome']
  },
  {
    id: 'hr_i_2',
    topic: 'hr',
    difficulty: 'intermediate',
    question: 'Tell me about a time you missed a deadline or made a critical mistake in a project. What happened and what did you learn?',
    expectedAnswer: 'Acknowledge mistake openly, explain immediate remediation steps taken to minimize impact, and describe the systemic improvements adopted to prevent recurrence.',
    keyPoints: ['Accountability without excuses', 'Immediate mitigation', 'Long-term learning & process improvement']
  },

  // HR Advanced
  {
    id: 'hr_a_1',
    topic: 'hr',
    difficulty: 'advanced',
    question: 'Where do you see yourself in 3 to 5 years, and how does this role fit into your long-term career roadmap?',
    expectedAnswer: 'Discuss progression from delivering independent high-impact modules to technical leadership, mentoring junior engineers, and contributing to core architectural decisions.',
    keyPoints: ['Realistic career trajectory', 'Commitment to continuous learning', 'Mentorship and leadership aspirations']
  },

  // ==========================================================
  // 6. PERSONAL INTERVIEW
  // ==========================================================
  {
    id: 'personal_b_1',
    topic: 'personal',
    difficulty: 'beginner',
    question: 'Walk me through a project you built recently. What problem were you solving, what technologies did you choose, and why?',
    expectedAnswer: 'Explain problem statement, architecture choices (e.g. React for UI, Node/Express for API, PostgreSQL for schema integrity), key achievements, and what was learned.',
    keyPoints: ['Clear problem statement', 'Tech stack justification', 'Key challenges overcome']
  },
  {
    id: 'personal_i_1',
    topic: 'personal',
    difficulty: 'intermediate',
    question: 'How do you handle ambiguous requirements when a project specification is incomplete or constantly changing?',
    expectedAnswer: 'Communicate early, break project into modular milestones, write down assumptions, consult stakeholders for clarification, and build with flexible, decoupled abstractions.',
    keyPoints: ['Proactive communication', 'Documenting assumptions', 'Incremental prototyping', 'Adaptability']
  },
  {
    id: 'personal_a_1',
    topic: 'personal',
    difficulty: 'advanced',
    question: 'Tell me about a time you took initiative to improve an engineering process, codebase, or team workflow without being asked.',
    expectedAnswer: 'Describe identifying a bottleneck (e.g. manual testing, poor documentation, slow CI), taking personal ownership to automate/fix it, and measuring positive team impact.',
    keyPoints: ['Proactivity and ownership', 'Measurable impact', 'Mentorship & culture enhancement']
  },

  // ==========================================================
  // 7. HTML / CSS / JAVASCRIPT
  // ==========================================================
  {
    id: 'hcjs_b_1',
    topic: 'htmlcssjs',
    difficulty: 'beginner',
    question: 'What are semantic HTML tags (like <header>, <article>, <section>, <nav>) and why are they important for accessibility and SEO?',
    expectedAnswer: 'Semantic HTML tags clearly describe their meaning to both the browser and developer, providing accessibility landmarks for screen readers, improving SEO crawlability, and creating cleaner code structure.',
    keyPoints: ['Accessibility (a11y) landmarks', 'SEO indexing benefits', 'Code maintainability']
  },
  {
    id: 'hcjs_b_2',
    topic: 'htmlcssjs',
    difficulty: 'beginner',
    question: 'Explain CSS Flexbox layout: justify-content versus align-items and flex-direction.',
    expectedAnswer: 'Flexbox distributes space along the main axis and cross axis. flex-direction defines the main axis (row or column). justify-content aligns items along the main axis; align-items aligns items along the cross axis.',
    keyPoints: ['Main axis vs Cross axis', 'flex-direction: row | column', 'justify-content vs align-items']
  },
  {
    id: 'hcjs_i_1',
    topic: 'htmlcssjs',
    difficulty: 'intermediate',
    question: 'What is the difference between CSS Grid and Flexbox, and how do you choose which to use in a web layout?',
    expectedAnswer: 'Flexbox is one-dimensional (row OR column), ideal for distributing components in a bar or linear alignment. CSS Grid is two-dimensional (rows AND columns simultaneously), ideal for overall page scaffolding, complex dashboards, and responsive card grids.',
    keyPoints: ['1D (Flexbox) vs 2D (Grid)', 'Content-first vs Layout-first', 'fr units and grid-template-areas']
  },
  {
    id: 'hcjs_i_2',
    topic: 'htmlcssjs',
    difficulty: 'intermediate',
    question: 'Explain JavaScript Prototypal Inheritance and how the prototype chain works when accessing an object property.',
    expectedAnswer: 'In JavaScript, objects inherit directly from other objects via a hidden [[Prototype]] link (__proto__). When a property is accessed, the JS engine checks the object; if absent, it traverses up the prototype chain until found or reaches Object.prototype (null).',
    keyPoints: ['[[Prototype]] link', 'Object.prototype at chain root', 'Delegation rather than class copying']
  },
  {
    id: 'hcjs_a_1',
    topic: 'htmlcssjs',
    difficulty: 'advanced',
    question: 'How does the browser rendering engine work (DOM, CSSOM, Render Tree, Layout/Reflow, Paint, Composite), and how do you minimize layout thrashing?',
    expectedAnswer: 'Browser parses HTML into DOM, CSS into CSSOM, combines them into Render Tree, calculates geometry (Layout/Reflow), paints pixels (Paint), and composites layers via GPU. To avoid layout thrashing: batch DOM reads and writes (avoid interleaved read-write layout properties like offsetTop), use transform and opacity which trigger GPU compositing without layout reflow.',
    keyPoints: ['DOM + CSSOM = Render Tree', 'Reflow vs Repaint vs Composite', 'GPU accelerated properties: transform & opacity', 'Avoiding layout thrashing']
  },

  // ==========================================================
  // 8. TECHNICAL INTERVIEW (Architecture, OOP & System Design)
  // ==========================================================
  {
    id: 'tech_b_1',
    topic: 'technical',
    difficulty: 'beginner',
    question: 'What are the SOLID design principles in software engineering? Explain each letter with a practical example.',
    expectedAnswer: 'S: Single Responsibility (one reason to change), O: Open/Closed (open for extension, closed for modification), L: Liskov Substitution (subtypes must be substitutable for base types), I: Interface Segregation (client specific small interfaces), D: Dependency Inversion (depend on abstractions, not concretions).',
    keyPoints: ['Single Responsibility Principle', 'Open/Closed Principle', 'Liskov Substitution', 'Interface Segregation', 'Dependency Inversion']
  },
  {
    id: 'tech_i_1',
    topic: 'technical',
    difficulty: 'intermediate',
    question: 'What is the difference between Monolithic architecture and Microservices? What are the key trade-offs in operational complexity and network latency?',
    expectedAnswer: 'Monolith: single deployable unit, simple debugging and ACID transactions, but hard to scale independently and deploy frequently. Microservices: independently deployable services around business domains, autonomous teams and tech stacks, but introduces network latency, distributed transactions (Saga), eventual consistency, and complex observability.',
    keyPoints: ['Single deployment vs Distributed services', 'ACID vs Eventual consistency', 'Network latency and inter-service failure', 'Saga pattern and API Gateway']
  },
  {
    id: 'tech_a_1',
    topic: 'technical',
    difficulty: 'advanced',
    question: 'How would you architect a high-throughput, low-latency URL Shortener service (like bit.ly) handling 100M URLs per day? Discuss database choice, hashing vs counter-based ID generation, and caching.',
    expectedAnswer: '1) ID Generation: Use 64-bit distributed unique ID (like Snowflake or ZooKeeper-managed counter ranges) converted to Base62 string (6-7 chars). Avoid hashing MD5/SHA with collision checks. 2) Database: Key-Value or NoSQL (DynamoDB/Cassandra) for O(1) reads/writes partitioned by short_url. 3) Caching: Redis cluster storing 20% hottest URLs (80-20 rule) with LRU eviction. 4) Scalability: Rate limiting via Token Bucket, CDN for static redirect caching.',
    keyPoints: ['Base62 encoding of unique distributed IDs', 'Snowflake ID vs Hash collisions', 'Redis LRU cache for 80/20 rule', 'Partition key design']
  },

  // ==========================================================
  // 9. CUSTOM / INDUSTRY ROLE INTERVIEWS
  // ==========================================================
  {
    id: 'custom_b_1',
    topic: 'custom',
    difficulty: 'beginner',
    question: 'How do you approach learning and onboarding onto a large, unfamiliar enterprise codebase?',
    expectedAnswer: 'Start by running the application locally, understanding the end-to-end data flow for a single core user journey, reading architecture documentation, reviewing recent PRs, and taking on small bug fixes first.',
    keyPoints: ['Local setup & verification', 'Trace one user request end-to-end', 'Incremental onboarding']
  },
  {
    id: 'custom_i_1',
    topic: 'custom',
    difficulty: 'intermediate',
    question: 'Explain CI/CD (Continuous Integration & Continuous Deployment) pipelines: how do automated linting, testing, and deployment stages ensure production reliability?',
    expectedAnswer: 'CI automatically validates every commit via linting, unit tests, and security scans on pull requests. CD packages the artifact (Docker container) and promotes it through staging and production with automated smoke tests, blue-green deployments, or canary rollouts.',
    keyPoints: ['Automated PR testing', 'Artifact immutability (Docker)', 'Canary and Blue-Green deployments', 'Rollback strategy']
  },
  {
    id: 'custom_a_1',
    topic: 'custom',
    difficulty: 'advanced',
    question: 'How do you manage Technical Debt in a team balancing aggressive feature deadlines with system stability?',
    expectedAnswer: 'Categorize tech debt by risk and cost of delay, maintain a visible engineering backlog, dedicate ~20% of sprint capacity to debt refactoring, pair refactoring with new feature work, and track metrics like error rates and developer cycle time.',
    keyPoints: ['Quantify cost of delay', '20% allocation in sprint planning', 'Boy Scout rule (leave code cleaner)', 'Architectural decision records (ADRs)']
  }
];

function loadQuestionBank() {
  try {
    if (fs.existsSync(QUESTIONS_FILE)) {
      const raw = fs.readFileSync(QUESTIONS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
        questionBank = parsed.questions;
        return;
      }
    }
  } catch (e) {
    console.warn('Could not load custom question bank, initializing with seed:', e.message);
  }

  // Initialize with seed
  questionBank = [...SEED_QUESTIONS];
  saveQuestionBank();
}

function saveQuestionBank() {
  try {
    const payload = JSON.stringify({
      version: '1.0',
      updatedAt: new Date().toISOString(),
      totalCount: questionBank.length,
      questions: questionBank
    }, null, 2);
    fs.writeFileSync(TMP_FILE, payload, 'utf8');
    fs.renameSync(TMP_FILE, QUESTIONS_FILE);
  } catch (e) {
    console.error('Error saving interview question bank:', e.message);
  }
}

loadQuestionBank();

function getAllQuestions(filters = {}) {
  let list = [...questionBank];
  if (filters.topic && filters.topic !== 'all') {
    const t = String(filters.topic).toLowerCase();
    list = list.filter(q => q.topic.toLowerCase() === t);
  }
  if (filters.difficulty && filters.difficulty !== 'all') {
    const d = String(filters.difficulty).toLowerCase();
    list = list.filter(q => q.difficulty.toLowerCase() === d);
  }
  if (filters.search) {
    const s = String(filters.search).toLowerCase();
    list = list.filter(q =>
      (q.question && q.question.toLowerCase().includes(s)) ||
      (q.expectedAnswer && q.expectedAnswer.toLowerCase().includes(s)) ||
      (q.topic && q.topic.toLowerCase().includes(s))
    );
  }
  return list;
}

function getQuestionsForTopicAndDifficulty(topic, difficulty) {
  const normTopic = String(topic || 'technical').toLowerCase();
  const normDiff = String(difficulty || 'intermediate').toLowerCase();
  let matches = questionBank.filter(q =>
    q.topic.toLowerCase() === normTopic && q.difficulty.toLowerCase() === normDiff
  );
  if (matches.length === 0) {
    matches = questionBank.filter(q => q.topic.toLowerCase() === normTopic);
  }
  if (matches.length === 0) {
    matches = questionBank.filter(q => q.difficulty.toLowerCase() === normDiff);
  }
  return matches.length > 0 ? matches : questionBank;
}

function addQuestion({ topic, difficulty, question, expectedAnswer, keyPoints }) {
  if (!topic || !question) throw new Error('Topic and Question text are required');
  const normTopic = String(topic).toLowerCase().trim();
  const normDiff = ['beginner', 'intermediate', 'advanced'].includes(String(difficulty).toLowerCase())
    ? String(difficulty).toLowerCase()
    : 'intermediate';

  const newId = `q_${normTopic}_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;
  const item = {
    id: newId,
    topic: normTopic,
    difficulty: normDiff,
    question: question.trim(),
    expectedAnswer: (expectedAnswer || '').trim(),
    keyPoints: Array.isArray(keyPoints) ? keyPoints : (keyPoints ? String(keyPoints).split(',').map(s => s.trim()).filter(Boolean) : [])
  };

  questionBank.unshift(item);
  saveQuestionBank();
  return item;
}

function updateQuestion(id, updates = {}) {
  const idx = questionBank.findIndex(q => q.id === id);
  if (idx === -1) throw new Error('Question not found');
  const existing = questionBank[idx];

  if (updates.topic) existing.topic = String(updates.topic).toLowerCase().trim();
  if (updates.difficulty) existing.difficulty = String(updates.difficulty).toLowerCase().trim();
  if (updates.question) existing.question = updates.question.trim();
  if (updates.expectedAnswer !== undefined) existing.expectedAnswer = updates.expectedAnswer.trim();
  if (updates.keyPoints !== undefined) {
    existing.keyPoints = Array.isArray(updates.keyPoints)
      ? updates.keyPoints
      : String(updates.keyPoints).split(',').map(s => s.trim()).filter(Boolean);
  }

  saveQuestionBank();
  return existing;
}

function deleteQuestion(id) {
  const idx = questionBank.findIndex(q => q.id === id);
  if (idx === -1) throw new Error('Question not found');
  const deleted = questionBank.splice(idx, 1)[0];
  saveQuestionBank();
  return deleted;
}

function getStats() {
  const byTopic = {};
  const byDifficulty = { beginner: 0, intermediate: 0, advanced: 0 };
  for (const q of questionBank) {
    byTopic[q.topic] = (byTopic[q.topic] || 0) + 1;
    byDifficulty[q.difficulty] = (byDifficulty[q.difficulty] || 0) + 1;
  }
  return {
    totalQuestions: questionBank.length,
    byTopic,
    byDifficulty
  };
}

module.exports = {
  getAllQuestions,
  getQuestionsForTopicAndDifficulty,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  getStats,
  saveQuestionBank
};

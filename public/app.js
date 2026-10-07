const API_URL = '/matches';
let allMatches = [];
let currentPage = 1;
let isLoading = false;
let hasMore = true;
let currentYearFilter = '';

// Format date without timezone conversion
function formatDate(dateString) {
  const [year, month, day] = dateString.split('T')[0].split('-');
  const date = new Date(year, parseInt(month) - 1, day);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

document.addEventListener('DOMContentLoaded', () => {
  fetchAllMatches();
  fetchMatches();
  setupFilters();
  setupNavigation();
  setupInfiniteScroll();
  setupScrollProgress();
  setupBackToTop();
  setupStatsSync();
});

function setupStatsSync() {
  const title = document.getElementById('stats-title');
  const controls = document.getElementById('stats-sync-controls');
  const openButton = document.getElementById('stats-sync-open');
  const form = document.getElementById('stats-sync-form');
  const keyInput = document.getElementById('stats-sync-key');
  const submitButton = document.getElementById('stats-sync-submit');
  const status = document.getElementById('stats-sync-status');
  let clicks = 0;
  let lastClick = 0;
  let syncing = false;

  function reveal() {
    const now = Date.now();
    clicks = now - lastClick > 2000 ? 1 : clicks + 1;
    lastClick = now;
    if (clicks === 4) {
      controls.hidden = false;
      controls.classList.remove('hidden');
      openButton.focus();
    }
  }

  title.addEventListener('click', reveal);
  title.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      reveal();
    }
  });
  openButton.addEventListener('click', () => {
    form.hidden = false;
    form.classList.remove('hidden');
    openButton.setAttribute('aria-expanded', 'true');
    keyInput.focus();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (syncing) return;
    const key = keyInput.value.trim();
    if (!key) {
      keyInput.focus();
      return;
    }
    syncing = true;
    submitButton.disabled = true;
    openButton.disabled = true;
    keyInput.disabled = true;
    keyInput.value = '';
    status.dataset.state = 'loading';
    status.textContent = 'Fetching and updating stats…';
    form.setAttribute('aria-busy', 'true');

    try {
      const response = await fetch('/admin/stats/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) {
        const diagnostic = result.databaseCode && result.stage ? ` (${result.databaseCode}; ${result.stage})` : '';
        throw new Error((result.message || 'Unable to update stats. Please try again.') + diagnostic);
      }

      status.dataset.state = 'success';
      status.textContent = `Stats updated: ${result.inserted} new, ${result.updated} corrected, ${result.unchanged} unchanged.`;
      form.hidden = true;
      form.classList.add('hidden');
      openButton.setAttribute('aria-expanded', 'false');
      await refreshStatsAfterSync();
    } catch (error) {
      status.dataset.state = 'error';
      status.textContent =
        error.message === 'Failed to fetch' ? 'Connection lost. Check the stats before trying again.' : error.message;
    } finally {
      syncing = false;
      submitButton.disabled = false;
      openButton.disabled = false;
      keyInput.disabled = false;
      form.setAttribute('aria-busy', 'false');
    }
  });
}

async function refreshStatsAfterSync() {
  await fetchAllMatches();
  ['teams', 'competitions', 'opponents'].forEach(view => window.resetView(view));
  // Invalidate a match-history request that started before the update completed.
  matchesRequestVersion++;
  isLoading = false;
  currentPage = 1;
  hasMore = true;
  document.getElementById('matches-grid').innerHTML = '';
  await fetchMatches(currentYearFilter);
}

// Scroll Progress Bar
function setupScrollProgress() {
  const progressBar = document.getElementById('scroll-progress');

  window.addEventListener('scroll', () => {
    const winScroll = document.body.scrollTop || document.documentElement.scrollTop;
    const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    const scrolled = (winScroll / height) * 100;
    progressBar.style.width = scrolled + '%';
  });
}

// Back to Top Button
function setupBackToTop() {
  const backToTop = document.getElementById('back-to-top');

  window.addEventListener('scroll', () => {
    if (window.scrollY > 500) {
      backToTop.classList.add('visible');
    } else {
      backToTop.classList.remove('visible');
    }
  });

  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// Animated Counter
function animateCounter(element, target, duration = 1500) {
  const start = 0;
  const startTime = performance.now();

  function updateCounter(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Easing function for smooth animation
    const easeOutQuart = 1 - Math.pow(1 - progress, 4);
    const current = Math.floor(start + (target - start) * easeOutQuart);

    element.textContent = current.toLocaleString();

    if (progress < 1) {
      requestAnimationFrame(updateCounter);
    } else {
      element.textContent = target.toLocaleString();
      element.classList.add('counting');
      setTimeout(() => element.classList.remove('counting'), 500);
    }
  }

  requestAnimationFrame(updateCounter);
}

async function fetchAllMatches() {
  try {
    const response = await fetch(`${API_URL}?limit=10000`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load stats');
    allMatches = await response.json();
    populateLists();
    renderStats(allMatches);
  } catch (error) {
    console.error('Error fetching all matches:', error);
  }
}

function setupNavigation() {
  const links = document.querySelectorAll('.sidebar-nav a');
  const views = ['home', 'teams', 'competitions', 'opponents'];

  links.forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const viewName = link.dataset.view;

      links.forEach(l => l.classList.remove('active'));
      link.classList.add('active');

      views.forEach(view => {
        const el = document.getElementById(`view-${view}`);
        if (view === viewName) {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      });

      // Scroll to top when switching views
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

function populateLists() {
  const teams = [...new Set(allMatches.map(m => m.team))].sort();
  renderGridList('teams-grid', teams, 'team');

  const competitions = [...new Set(allMatches.map(m => m.competition))].sort();
  renderGridList('competitions-grid', competitions, 'competition');

  const opponents = [...new Set(allMatches.map(m => m.opponent))].sort();
  renderGridList('opponents-grid', opponents, 'opponent');

  populateYears(allMatches);
}

function renderGridList(elementId, items, type) {
  const container = document.getElementById(elementId);
  container.innerHTML = items
    .map(
      item => `
        <div class="grid-item" onclick="showStats('${type}', '${item.replace(/'/g, "\\'")}')">
            <h3>${item}</h3>
            <p>Click to view stats</p>
        </div>
    `,
    )
    .join('');
}

async function showStats(type, value) {
  const viewId = type === 'team' ? 'teams' : type === 'competition' ? 'competitions' : 'opponents';
  const statsContainer = document.getElementById(
    `${type === 'team' ? 'team' : type === 'competition' ? 'competition' : 'opponent'}-stats`,
  );

  const filteredMatches = allMatches.filter(m => m[type] === value);

  const totalMatches = filteredMatches.length;
  const goals = filteredMatches.reduce((acc, m) => acc + m.goals, 0);
  const assists = filteredMatches.reduce((acc, m) => acc + m.assists, 0);
  const hatTricks = filteredMatches.reduce((acc, m) => acc + m.hatTricks, 0);
  const motm = filteredMatches.reduce((acc, m) => acc + (m.motm ? 1 : 0), 0);
  const minutes = filteredMatches.reduce((acc, m) => acc + m.minutesPlayed, 0);

  statsContainer.innerHTML = `
        <div class="section-header">
            <h2>${value}</h2>
            <button class="btn btn-secondary" onclick="resetView('${viewId}')">← Back to List</button>
        </div>
        <div class="stats-summary">
            <div class="stat-card">
                <div class="stat-icon">⚽</div>
                <div class="stat-label">Goals</div>
                <div class="stat-value" data-target="${goals}">0</div>
            </div>
            <div class="stat-card">
                <div class="stat-icon">🎯</div>
                <div class="stat-label">Assists</div>
                <div class="stat-value" data-target="${assists}">0</div>
            </div>
            <div class="stat-card">
                <div class="stat-icon">📊</div>
                <div class="stat-label">Matches</div>
                <div class="stat-value" data-target="${totalMatches}">0</div>
            </div>
            <div class="stat-card">
                <div class="stat-icon">🎩</div>
                <div class="stat-label">Hat-tricks</div>
                <div class="stat-value" data-target="${hatTricks}">0</div>
            </div>
            <div class="stat-card">
                <div class="stat-icon">⭐</div>
                <div class="stat-label">MOTM</div>
                <div class="stat-value" data-target="${motm}">0</div>
            </div>
            <div class="stat-card">
                <div class="stat-icon">⏱️</div>
                <div class="stat-label">Minutes</div>
                <div class="stat-value" data-target="${minutes}">0</div>
            </div>
        </div>
        <div class="section-header" style="margin-top: 2rem;">
            <h2>Match History</h2>
        </div>
        <div class="matches-grid">
            ${renderMatchesHTML(filteredMatches)}
        </div>
    `;

  document.getElementById(`${viewId}-grid`).classList.add('hidden');
  statsContainer.classList.remove('hidden');

  // Animate stats counters
  setTimeout(() => {
    statsContainer.querySelectorAll('.stat-value[data-target]').forEach(el => {
      animateCounter(el, parseInt(el.dataset.target));
    });
  }, 100);
}

window.resetView = function (viewId) {
  document.getElementById(`${viewId}-grid`).classList.remove('hidden');
  const statsContainer = document.getElementById(
    `${viewId === 'teams' ? 'team' : viewId === 'competitions' ? 'competition' : 'opponent'}-stats`,
  );
  statsContainer.classList.add('hidden');
  statsContainer.innerHTML = '';
};

let matchesRequestVersion = 0;

async function fetchMatches(year = '') {
  if (isLoading) return;

  if (year !== currentYearFilter) {
    currentYearFilter = year;
    currentPage = 1;
    hasMore = true;
    document.getElementById('matches-grid').innerHTML = '';
  }

  if (!hasMore) return;

  isLoading = true;
  const requestVersion = ++matchesRequestVersion;
  const grid = document.getElementById('matches-grid');

  if (currentPage === 1 && !grid.children.length) {
    grid.innerHTML = Array(6).fill('<div class="match-card loading"></div>').join('');
  }

  try {
    const url = `${API_URL}?page=${currentPage}&limit=20${year ? `&year=${year}` : ''}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load matches');
    const matches = await response.json();
    if (requestVersion !== matchesRequestVersion) return;

    if (currentPage === 1) {
      grid.innerHTML = '';
    }

    if (matches.length < 20) {
      hasMore = false;
    }

    if (matches.length === 0 && currentPage === 1) {
      grid.innerHTML = '<p class="no-results">No matches found for this criteria.</p>';
    } else {
      const matchesHTML = renderMatchesHTML(matches);
      grid.insertAdjacentHTML('beforeend', matchesHTML);
      currentPage++;
    }
  } catch (error) {
    if (requestVersion !== matchesRequestVersion) return;
    console.error('Error fetching matches:', error);
    if (currentPage === 1) {
      grid.innerHTML = '<p class="error">Failed to load matches. Please try again later.</p>';
    }
  } finally {
    if (requestVersion === matchesRequestVersion) isLoading = false;
  }
}

function setupInfiniteScroll() {
  window.addEventListener('scroll', () => {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
      if (!document.getElementById('view-home').classList.contains('hidden')) {
        fetchMatches(currentYearFilter);
      }
    }
  });
}

function renderStats(matches) {
  const totalMatches = matches.length;
  const totalGoals = matches.reduce((acc, match) => acc + (match.goals || 0), 0);
  const totalAssists = matches.reduce((acc, match) => acc + (match.assists || 0), 0);
  const totalHatTricks = matches.reduce((acc, match) => acc + (match.hatTricks || 0), 0);
  const totalMotm = matches.reduce((acc, match) => acc + (match.motm ? 1 : 0), 0);
  const totalMinutes = matches.reduce((acc, match) => acc + (match.minutesPlayed || 0), 0);

  const summaryHTML = `
        <div class="stat-card">
            <div class="stat-icon">⚽</div>
            <div class="stat-label">Total Goals</div>
            <div class="stat-value" data-target="${totalGoals}">0</div>
        </div>
        <div class="stat-card">
            <div class="stat-icon">🎯</div>
            <div class="stat-label">Total Assists</div>
            <div class="stat-value" data-target="${totalAssists}">0</div>
        </div>
        <div class="stat-card">
            <div class="stat-icon">📊</div>
            <div class="stat-label">Total Matches</div>
            <div class="stat-value" data-target="${totalMatches}">0</div>
        </div>
        <div class="stat-card">
            <div class="stat-icon">🎩</div>
            <div class="stat-label">Hat-tricks</div>
            <div class="stat-value" data-target="${totalHatTricks}">0</div>
        </div>
        <div class="stat-card">
            <div class="stat-icon">⭐</div>
            <div class="stat-label">Man of the Match</div>
            <div class="stat-value" data-target="${totalMotm}">0</div>
        </div>
        <div class="stat-card">
            <div class="stat-icon">⏱️</div>
            <div class="stat-label">Minutes Played</div>
            <div class="stat-value" data-target="${totalMinutes}">0</div>
        </div>
    `;

  document.getElementById('stats-summary').innerHTML = summaryHTML;

  // Animate counters after rendering
  setTimeout(() => {
    document.querySelectorAll('#stats-summary .stat-value[data-target]').forEach(el => {
      animateCounter(el, parseInt(el.dataset.target));
    });
  }, 300);
}

function getResultBadge(match) {
  const result =
    match.teamScore > match.opponentScore ? 'win' : match.teamScore < match.opponentScore ? 'loss' : 'draw';
  const label = result === 'win' ? 'W' : result === 'loss' ? 'L' : 'D';
  return `<span class="result-badge ${result}">${label}</span>`;
}

function renderMatchesHTML(matches) {
  return matches
    .map(match => {
      const homeTeam = match.home ? match.team : match.opponent;
      const awayTeam = match.home ? match.opponent : match.team;
      const homeScore = match.home ? match.teamScore : match.opponentScore;
      const awayScore = match.home ? match.opponentScore : match.teamScore;

      return `
        <div class="match-card">
            ${getResultBadge(match)}
            <div class="match-header">
                <span class="match-date">📅 ${formatDate(match.matchDate)}</span>
                <span class="match-competition">${match.competition}</span>
            </div>
            <div class="match-teams">
                <div class="team">
                    <span class="team-name">${homeTeam}</span>
                    <span class="score">${homeScore}</span>
                </div>
                <div class="team">
                    <span class="team-name">${awayTeam}</span>
                    <span class="score">${awayScore}</span>
                </div>
            </div>
            <div class="match-details">
                <span class="tag ${match.goals > 0 ? 'highlight' : ''}">⚽ ${match.goals} goal${match.goals !== 1 ? 's' : ''}</span>
                <span class="tag ${match.assists > 0 ? 'highlight' : ''}">🎯 ${match.assists} assist${match.assists !== 1 ? 's' : ''}</span>
                ${match.motm ? '<span class="tag highlight-gold">⭐ MOTM</span>' : ''}
                ${match.hatTricks > 0 ? '<span class="tag highlight-gold">🎩 Hat-trick</span>' : ''}
            </div>
        </div>
    `;
    })
    .join('');
}

function populateYears(matches) {
  const years = [
    ...new Set(
      matches.map(m => {
        const [year] = m.matchDate.split('T')[0].split('-');
        return parseInt(year);
      }),
    ),
  ].sort((a, b) => b - a);
  const select = document.getElementById('year-filter');

  while (select.options.length > 1) {
    select.remove(1);
  }

  years.forEach(year => {
    const option = document.createElement('option');
    option.value = year;
    option.textContent = year;
    select.appendChild(option);
  });
}

function setupFilters() {
  const select = document.getElementById('year-filter');
  select.addEventListener('change', e => {
    fetchMatches(e.target.value);
  });
}

// ==UserScript==
// @name         YouTube Auto Speed
// @namespace    https://github.com/oooooooo/youtube-auto-speed
// @version      1.0.2
// @description  Speeds up videos except for music. You can also adjust the speed manually.
// @author       ooooooooo
// @match        https://www.youtube.com/*
// @run-at       document-start
// @updateURL    https://github.com/oooooooo/youtube-auto-speed/raw/main/youtube-auto-speed.user.js
// @downloadURL  https://github.com/oooooooo/youtube-auto-speed/raw/main/youtube-auto-speed.user.js
// @supportURL   https://github.com/oooooooo/youtube-auto-speed
// @grant        none
// ==/UserScript==

(() => {
	// If the title contains these keywords, it is considered music.
	const KEYWORDS = ["カラオケ", "karaoke", "歌枠", "歌ってみた", "MV"];

	// If the video is shorter than this duration, it is considered music.
	const MAX_SLOW_DURATION_SEC = 6 * 60;

	const RATE_SLOW = 1.0;
	const RATE_FAST = 2.7;
	const CONTAINER_ID = "yt-speed-buttons-container-v4";
	const BTN_CLASS = "yt-speed-btn-v4";

	let currentRate = RATE_FAST;
	let manualOverride = false;
	let lastVideoId = null;
	let videoObserver = null;

	const style = `
    #${CONTAINER_ID} {
      display: flex;
      gap: 6px;
      align-items: center;
      margin-left: 10px;
    }
    .${BTN_CLASS} {
      font-family: "Roboto", Arial, sans-serif;
      font-size: 13px;
      padding: 6px 8px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.08);
      color: #fff;
      cursor: pointer;
      user-select: none;
    }
    .${BTN_CLASS}:hover { background: rgba(255,255,255,0.15); }
    .${BTN_CLASS}.active {
      background: rgba(255,255,255,0.22);
      border-color: rgba(255,255,255,0.25);
      font-weight: bold;
    }
  `;

	function injectStyle() {
		if (!document.getElementById("yt-speed-buttons-style")) {
			const s = document.createElement("style");
			s.id = "yt-speed-buttons-style";
			s.textContent = style;
			document.head.appendChild(s);
		}
	}

	function isShorts() {
		return location.pathname.startsWith("/shorts/");
	}

	function parseDuration(text) {
		if (!text) return null;

		const parts = text.trim().split(":").map(Number);

		if (parts.length === 2) {
			return parts[0] * 60 + parts[1];
		} else if (parts.length === 3) {
			return parts[0] * 3600 + parts[1] * 60 + parts[2];
		}
		return null;
	}

	function getVideoDuration() {
		const el = document.querySelector(".ytp-time-duration");
		if (!el) return null;
		return parseDuration(el.textContent);
	}

	function isTitleSlow() {
		// 複数のセレクタを試す（YouTubeのバージョンによってDOM構造が異なる）
		const selectors = [
			"#title h1 yt-formatted-string",
			"ytd-watch-metadata h1 yt-formatted-string",
			"#above-the-fold #title yt-formatted-string",
			"h1.title yt-formatted-string",
			"#title h1",
			"h1.title",
		];

		let title = "";
		for (const sel of selectors) {
			const el = document.querySelector(sel);
			if (el?.textContent?.trim()) {
				title = el.textContent;
				break;
			}
		}

		if (!title) return false;
		const lowerTitle = title.toLowerCase();
		return KEYWORDS.some((k) => lowerTitle.includes(k.toLowerCase()));
	}

	function getVideoId() {
		const params = new URLSearchParams(location.search);
		return params.get("v") || location.pathname;
	}

	function autoSetSpeed(retryCount = 0) {
		const videoId = getVideoId();

		// 動画が変わったら手動オーバーライドをリセット
		if (videoId !== lastVideoId) {
			lastVideoId = videoId;
			manualOverride = false;
		}

		// 手動で変更した場合は自動設定をスキップ
		if (manualOverride) {
			return;
		}

		if (isShorts()) {
			setPlaybackRate(RATE_FAST, false);
			return;
		}

		const durationSec = getVideoDuration();
		const titleMatch = isTitleSlow();

		// タイトルがまだ取得できない場合はリトライ
		if (!titleMatch && retryCount < 5) {
			const selectors = [
				"#title h1 yt-formatted-string",
				"ytd-watch-metadata h1 yt-formatted-string",
				"#above-the-fold #title yt-formatted-string",
			];
			const hasTitle = selectors.some(sel => {
				const el = document.querySelector(sel);
				return el?.textContent?.trim();
			});

			if (!hasTitle) {
				setTimeout(() => autoSetSpeed(retryCount + 1), 200);
				return;
			}
		}

		let rate = RATE_FAST;

		if (titleMatch) {
			rate = RATE_SLOW;
		} else if (durationSec != null && durationSec <= MAX_SLOW_DURATION_SEC) {
			rate = RATE_SLOW;
		}

		setPlaybackRate(rate, false);
	}

	function setPlaybackRate(rate, isManual = true) {
		if (isManual) {
			manualOverride = true;
		}
		currentRate = rate;
		document.querySelectorAll("video").forEach((v) => { v.playbackRate = rate; });

		document.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => {
			b.classList.toggle("active", parseFloat(b.dataset.rate) === rate);
		});
	}

	function createButtons() {
		if (document.getElementById(CONTAINER_ID)) return;

		const logo = document.querySelector("#logo");
		if (!logo || !logo.parentElement) return;

		const container = document.createElement("div");
		container.id = CONTAINER_ID;

		function mk(label, rate) {
			const b = document.createElement("button");
			b.className = BTN_CLASS;
			b.innerText = label;
			b.dataset.rate = rate;
			b.onclick = () => setPlaybackRate(rate);
			return b;
		}

		container.appendChild(mk(`x${RATE_SLOW.toFixed(1)}`, RATE_SLOW));
		container.appendChild(mk(`x${RATE_FAST.toFixed(1)}`, RATE_FAST));

		logo.parentElement.insertBefore(container, logo.nextSibling);

		setPlaybackRate(currentRate, false);
	}

	// 動画要素を監視して即座に速度を設定
	function setupVideoObserver() {
		if (videoObserver) return;

		videoObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of mutation.addedNodes) {
					if (node.nodeName === "VIDEO") {
						applySpeedToVideo(node);
					} else if (node.querySelectorAll) {
						node.querySelectorAll("video").forEach(applySpeedToVideo);
					}
				}
			}
		});

		videoObserver.observe(document.documentElement, {
			childList: true,
			subtree: true,
		});
	}

	function applySpeedToVideo(video) {
		video.playbackRate = currentRate;
		// 動画のメタデータ読み込み完了時に自動速度設定
		video.addEventListener("loadedmetadata", () => {
			autoSetSpeed();
		}, { once: true });
	}

	function init() {
		injectStyle();
		createButtons();
		setupVideoObserver();

		// 既存の動画にも即座に適用
		document.querySelectorAll("video").forEach(applySpeedToVideo);

		document.addEventListener("play", () => setPlaybackRate(currentRate, false), true);

		// YouTube SPAのナビゲーション完了イベント（初回ロード・ページ遷移両方で発火）
		window.addEventListener("yt-navigate-finish", () => {
			createButtons();
			autoSetSpeed();
		});
	}

	// DOMの準備ができたら即座に初期化
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();

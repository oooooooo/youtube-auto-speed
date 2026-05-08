// ==UserScript==
// @name         YouTube Auto Speed
// @namespace    https://github.com/oooooooo/youtube-auto-speed
// @version      1.0.3
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
	const BTN_CLASS = "yt-speed-btn-v5";

	let currentRate = RATE_FAST;
	let manualOverride = false;
	let lastVideoId = null;
	let videoObserver = null;
	const speedHooksAttached = new WeakSet();
	let playbackKeepAliveIntervalId = null;

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

	function getUiDurationSeconds() {
		const el = document.querySelector(".ytp-time-duration");
		if (!el) return null;
		return parseDuration(el.textContent);
	}

	function getVideoElementDurationSeconds(video) {
		const v =
			video ||
			document.querySelector("ytd-player video.video-stream") ||
			document.querySelector("video");
		if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return null;
		return v.duration;
	}

	/** プレイヤーUI が「0:00」のまま等のときは null（誤って短尺判定しない） */
	function getTrustworthyDurationSeconds() {
		const fromVideo = getVideoElementDurationSeconds();
		if (fromVideo != null) return fromVideo;
		const fromUi = getUiDurationSeconds();
		if (fromUi != null && fromUi > 0) return fromUi;
		return null;
	}

	/** 「mv」の部分一致だけだと動画タイトルを誤判定しやすいので、MV 表記だけ別判定 */
	function titleImpliesMusicVideoToken(title) {
		return (
			/【\s*MV\s*】|\(\s*MV\s*\)|「\s*MV\s*」|\bMV\b/i.test(title)
		);
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
		const plainKeywordMatch = KEYWORDS.some((k) => {
			if (k.toLowerCase() === "mv") return false;
			return lowerTitle.includes(k.toLowerCase());
		});
		return plainKeywordMatch || titleImpliesMusicVideoToken(title);
	}

	function getVideoId() {
		const params = new URLSearchParams(location.search);
		return params.get("v") || location.pathname;
	}

	function computeAutoRate() {
		if (isShorts()) {
			return RATE_FAST;
		}

		const titleMatch = isTitleSlow();
		const durationSec = getTrustworthyDurationSeconds();

		let rate = RATE_FAST;

		if (titleMatch) {
			rate = RATE_SLOW;
		} else if (
			durationSec != null &&
			durationSec <= MAX_SLOW_DURATION_SEC
		) {
			rate = RATE_SLOW;
		}

		return rate;
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

		const titleMatch = isTitleSlow();

		// タイトル未取得の間は長さも未確定のことが多い → まず速い速度を適用しつつタイトルを待つ
		if (!titleMatch && retryCount < 15) {
			const selectors = [
				"#title h1 yt-formatted-string",
				"ytd-watch-metadata h1 yt-formatted-string",
				"#above-the-fold #title yt-formatted-string",
			];
			const hasTitle = selectors.some((sel) => {
				const el = document.querySelector(sel);
				return el?.textContent?.trim();
			});

			if (!hasTitle) {
				setPlaybackRate(RATE_FAST, false);
				setTimeout(() => autoSetSpeed(retryCount + 1), 120);
				return;
			}
		}

		setPlaybackRate(computeAutoRate(), false);
	}

	function applyCurrentRateToAllVideos() {
		for (const v of document.querySelectorAll("video")) {
			if (Math.abs(v.playbackRate - currentRate) > 0.001) {
				v.playbackRate = currentRate;
			}
		}
	}

	function setPlaybackRate(rate, isManual = true) {
		if (isManual) {
			manualOverride = true;
		}
		currentRate = rate;
		applyCurrentRateToAllVideos();
		// YouTube が直後のフレームで 1.0 に戻すことがあるためマイクロタスクでもう一度合わせる
		queueMicrotask(applyCurrentRateToAllVideos);

		document.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => {
			b.classList.toggle("active", parseFloat(b.dataset.rate) === rate);
		});
	}

	function createButtons() {
		if (document.getElementById(CONTAINER_ID)) return;

		const logo = document.querySelector("#logo");
		if (!logo?.parentElement) return;

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
		if (speedHooksAttached.has(video)) return;
		speedHooksAttached.add(video);
		const onPersistRate = () => {
			queueMicrotask(() => {
				if (Math.abs(video.playbackRate - currentRate) > 0.001) {
					video.playbackRate = currentRate;
				}
			});
		};
		video.addEventListener("ratechange", onPersistRate);
		video.addEventListener("playing", onPersistRate);
		video.addEventListener("play", onPersistRate);

		// メタデータ・長さ確定のたびに再判定（UI の「0:00」誤判定の解消）
		const onDurationLike = () => {
			autoSetSpeed();
		};
		video.addEventListener("loadedmetadata", onDurationLike);
		video.addEventListener("durationchange", onDurationLike);
	}

	function startPlaybackKeepAlive() {
		if (playbackKeepAliveIntervalId != null) return;
		playbackKeepAliveIntervalId = window.setInterval(() => {
			for (const v of document.querySelectorAll("video")) {
				if (v.closest("iframe")) continue;
				const inMainPlayer =
					v.closest("ytd-player") != null ||
					v.closest("#movie_player") != null;
				if (!inMainPlayer) continue;

				if (!Number.isFinite(v.duration) || v.paused || v.ended) continue;
				if (Math.abs(v.playbackRate - currentRate) > 0.001) {
					v.playbackRate = currentRate;
				}
			}
		}, 450);
	}

	function init() {
		injectStyle();
		createButtons();
		setupVideoObserver();
		startPlaybackKeepAlive();

		// 既存の動画にも即座に適用
		document.querySelectorAll("video").forEach(applySpeedToVideo);

		// 初回ロード時にも自動速度設定を実行
		autoSetSpeed();

		document.addEventListener(
			"play",
			(e) => {
				const t = e.target;
				if (t instanceof HTMLVideoElement) applySpeedToVideo(t);
				setPlaybackRate(currentRate, false);
			},
			true,
		);

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

let automationRunning = false;

function getCourseraUserId() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "GET_USER_ID" }, (response) => {
      if (!response?.success) {
        resolve(null);
        return;
      }

      resolve(response.userId);
    });
  });
}

function createToastContainer() {
  if (document.getElementById("coursera-toast-container")) return;

  const container = document.createElement("div");
  container.id = "coursera-toast-container";

  container.style.cssText = `
    all: initial;
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    gap: 10px;
    pointer-events: none;
  `;

  // IMPORTANT: append to <html> NOT <body>
  document.documentElement.appendChild(container);
}

function showToast(message, type = "info") {
  createToastContainer();

  const toast = document.createElement("div");

  const colors = {
    success: "#2ecc71",
    error: "#e74c3c",
    info: "#3498db",
  };

  toast.style.cssText = `
    all: initial;
    background: ${colors[type] || "#333"};
    color: white;
    padding: 12px 16px;
    border-radius: 8px;
    font-size: 14px;
    font-family: system-ui, sans-serif;
    box-shadow: 0 4px 10px rgba(0,0,0,0.2);
    opacity: 0;
    transform: translateX(40px);
    transition: all 0.25s ease;
    pointer-events: auto;
    max-width: 300px;
  `;

  toast.textContent = message;

  const container = document.getElementById("coursera-toast-container");
  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateX(0)";
  });

  // Auto remove
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(40px)";

    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

async function fetchCourseMaterials() {
  const slug = location.pathname.split("/")[2];

  const url = `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${slug}
&includes=modules,lessons,passableItemGroups,passableItemGroupChoices,passableLessonElements,items,tracks,gradePolicy,gradingParameters,embeddedContentMapping
&fields=onDemandCourseMaterialItems.v2(name,slug,timeCommitment,contentSummary,isLocked)
&showLockedItems=true`;

  const response = await fetch(url, {
    credentials: "include", // SENDS COURSERA COOKIES
  });

  const data = await response.json();
  return data;
}

function extractMaterialTypes(apiData) {
  const items = apiData?.linked?.["onDemandCourseMaterialItems.v2"] || [];

  const result = {
    lecture: [],
    supplement: [],
    gradedProgramming: [],
    staffGraded: [],
    quiz: [],
    exam: [],
    ungradedWidget: [],
    ungradedLab: [],
    unknown: [],
  };

  items.forEach((item) => {
    const type = item?.contentSummary?.typeName || "unknown";

    const formattedItem = {
      id: item.id,
      name: item.name,
      slug: item.slug,
      lessonId: item.lessonId,
      moduleId: item.moduleId,
      time: item.timeCommitment,
      locked: item.isLocked,
    };

    if (result[type]) {
      result[type].push(formattedItem);
    } else {
      result.unknown.push({
        ...formattedItem,
        originalType: type,
      });
    }
  });
  return result;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "FETCH_DYNAMIC_DATA") {
    fetchCourseMaterials()
      .then((apiData) => {
        const parsed = extractMaterialTypes(apiData);

        sendResponse({
          success: true,
          data: parsed,
        });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: err.message,
        });
      });

    return true; // REQUIRED for async response
  }

  if (request.action === "RUN_AUTOMATION") {
    runAutomation(request.options);
  }
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markSupplementComplete(userId, courseId, itemId) {
  const response = await fetch(
    "https://www.coursera.org/api/onDemandSupplementCompletions.v1",
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId,
        courseId,
        itemId,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed: ${itemId}`);
  }

  return response.json();
}

async function getWidgetSessionId(userId, courseId, itemId) {
  const progressId = `${userId}~${courseId}~${itemId}`;

  const res = await fetch(
    `https://www.coursera.org/api/onDemandWidgetSessions.v1/${progressId}?fields=sessionId`,
    {
      credentials: "include",
    },
  );

  if (!res.ok) return null;

  const data = await res.json();

  return data?.elements?.[0]?.sessionId || null;
}

async function markUngradedWidgetComplete(userId, courseId, itemId) {
  const progressId = `${userId}~${courseId}~${itemId}`;

  const sessionId = await getWidgetSessionId(userId, courseId, itemId);

  if (!sessionId) {
    throw new Error("Widget session missing");
  }

  const response = await fetch(
    `https://www.coursera.org/api/onDemandWidgetProgress.v1/${progressId}`,
    {
      method: "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: sessionId,
        progressState: "Completed",
      }),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    console.error("Widget Progress Error:", err);
    throw new Error(`Widget failed: ${itemId}`);
  }

  return true;
}

async function sendVideoEvent(userId, courseSlug, itemId, event = "play") {
  const url =
    `https://www.coursera.org/api/opencourse.v1/user/${userId}` +
    `/course/${courseSlug}` +
    `/item/${itemId}` +
    `/lecture/videoEvents/${event}?autoEnroll=false`;

  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contentRequestBody: {},
    }),
  });

  if (!response.ok) {
    throw new Error(`Video ${event} failed`);
  }
}

async function updateVideoProgress(userId, courseId, videoId, duration) {
  const progressId = `${userId}~${courseId}~${videoId}`;

  const response = await fetch(
    `https://www.coursera.org/api/onDemandVideoProgresses.v1/${progressId}`,
    {
      method: "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        viewedUpTo: Math.floor(duration),
        videoProgressId: progressId,
      }),
    },
  );

  if (!response.ok) {
    throw new Error("Video progress update failed");
  }
}

async function runAutomation(options) {
  if (automationRunning) {
    showToast("⚠ Automation already running", "error");
    return;
  }

  automationRunning = true;

  showToast("🚀 Automation started", "info");

  // Get Coursera user ID
  const userId = await getCourseraUserId();

  if (!userId) {
    showToast("Login required", "error");
    console.error("User ID missing");
    return;
  }

  // Fetch course material again (fresh data)
  const apiData = await fetchCourseMaterials();
  const parsed = extractMaterialTypes(apiData);

  // Course ID
  const courseId = apiData?.elements?.[0]?.id;

  if (!courseId) {
    console.error("Course ID missing");
    showToast("Not a valid course", "error");
    return;
  }

  if (options.supplement && parsed.supplement.length > 0) {
    showToast("📘 Starting readings automation...", "info");

    let completed = 0;
    for (const item of parsed.supplement) {
      try {
        await markSupplementComplete(userId, courseId, item.id);
        completed++;
        showToast(
          `✅ Completed ${completed}/${parsed.supplement.length}`,
          "info",
        );
        await delay(200);
      } catch (err) {
        showToast(`❌ Failed: ${item.name}`, "error");
      }
    }

    showToast("🎉 All readings completed!", "success");
  }

  if (options.lecture && parsed.lecture.length > 0) {
    showToast("🎥 Starting lecture automation...", "info");

    const courseSlug = location.pathname.split("/")[2];

    let completed = 0;
    for (const video of parsed.lecture) {
      try {
        const duration = video.time;
        await sendVideoEvent(userId, courseSlug, video.id, "play");
        await updateVideoProgress(userId, courseId, video.id, duration);
        await sendVideoEvent(userId, courseSlug, video.id, "ended");
        completed++;
        showToast(`✅ Completed ${completed}/${parsed.lecture.length}`, "info");
        await delay(500);
      } catch (err) {
        showToast(`❌ Failed: ${video.name}`, "error");
      }
    }

    showToast("🎉 All lecture videos completed!", "success");
  }

  if (options.ungradedWidget && parsed.ungradedWidget.length > 0) {
    showToast("📦 Starting Ungraded Plugin automation...", "info");
    let completed = 0;
    for (const item of parsed.ungradedWidget) {
      try {
        await markUngradedWidgetComplete(userId, courseId, item.id);
        completed++;
        showToast(
          `✅ Completed ${completed}/${parsed.ungradedWidget.length}`,
          "info",
        );
        await delay(200);
      } catch (err) {
        console.log(err);
        showToast(`❌ Failed: ${item.name}`, "error");
      }
    }
  }

  automationRunning = false;
  showToast("🎉 Automation completed!", "success");
}

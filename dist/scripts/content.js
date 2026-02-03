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
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    display: flex;
    flex-direction: column;
    gap: 10px;
    pointer-events: none;
  `;

  document.body.appendChild(container);
}

function showToast(message, type = "info") {
  createToastContainer();

  const toast = document.createElement("div");

  let bgColor = "#333";

  if (type === "success") bgColor = "#2ecc71";
  if (type === "error") bgColor = "#e74c3c";
  if (type === "info") bgColor = "#3498db";

  toast.style.cssText = `
    background: ${bgColor};
    color: white;
    padding: 12px 16px;
    border-radius: 8px;
    font-size: 14px;
    font-family: system-ui, sans-serif;
    box-shadow: 0 4px 10px rgba(0,0,0,0.2);
    opacity: 0;
    transform: translateX(50px);
    transition: all 0.3s ease;
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

  // Remove after 3s
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(50px)";

    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
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
    showToast("Course ID missing", "error");
    return;
  }

  if (options.supplement) {
    showToast("📘 Starting readings automation...", "info");

    for (const item of parsed.supplement) {
      try {
        // showToast(`⏳ Completing: ${item.name}`, "info");
        await markSupplementComplete(userId, courseId, item.id);
        // showToast(`✅ Completed: ${item.name}`, "success");
        // await delay(2000);
      } catch (err) {
        console.error("Failed:", item.slug, err.message);
        showToast(`❌ Failed: ${item.name}`, "error");
      }
    }

    showToast("🎉 All readings completed!", "success");
  }

  if (options.lecture) {
    showToast("🎥 Starting lecture automation...", "info");

    const courseSlug = location.pathname.split("/")[2];

    console.log(parsed.lecture);

    let completed = 0;
    for (const video of parsed.lecture) {
      try {
        const duration = video.time;
        // showToast(`▶ Playing: ${video.name}`, "info");
        await sendVideoEvent(userId, courseSlug, video.id, "play");
        await updateVideoProgress(userId, courseId, video.id, duration);
        await sendVideoEvent(userId, courseSlug, video.id, "ended");
        completed++;
        showToast(
          `✅ Completed ${completed}/${parsed.lecture.length}`,
          "success",
        );
        await delay(500);
      } catch (err) {
        console.error("Video error:", video.slug, err.message);
        showToast(`❌ Failed: ${video.name}`, "error");
      }
    }

    showToast("🎉 All lecture videos completed!", "success");
  }

  automationRunning = false;
  showToast("🎉 Automation completed!", "success");
}

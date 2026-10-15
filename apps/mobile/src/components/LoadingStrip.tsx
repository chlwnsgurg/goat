import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useVisibleAnimation } from "../lib/use-visible-animation";

const INDICATOR_WIDTH_FRACTION = 0.3;
const MIN_INDICATOR_WIDTH = 48;

function LoadingStripFrame(props: {
  readonly children: React.ReactNode;
  readonly onLayout?: (width: number) => void;
}) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden"
      onLayout={
        props.onLayout
          ? (event) => {
              props.onLayout?.(event.nativeEvent.layout.width);
            }
          : undefined
      }
    >
      {props.children}
    </View>
  );
}

function IndeterminateLoadingStrip() {
  const animationVisible = useVisibleAnimation();
  const [containerWidth, setContainerWidth] = useState(0);
  const travelProgress = useSharedValue(0);
  const indicatorWidth = Math.max(MIN_INDICATOR_WIDTH, containerWidth * INDICATOR_WIDTH_FRACTION);

  useEffect(() => {
    cancelAnimation(travelProgress);
    // oxlint-disable-next-line react/immutability -- Reanimated shared values intentionally mutate on the UI thread.
    travelProgress.value = 0;
    if (!animationVisible) return;
    travelProgress.value = withRepeat(
      withTiming(1, {
        duration: 1100,
        reduceMotion: ReduceMotion.System,
        easing: Easing.inOut(Easing.quad),
      }),
      -1,
      false,
    );

    return () => {
      cancelAnimation(travelProgress);
    };
  }, [animationVisible, travelProgress]);

  const indicatorStyle = useAnimatedStyle(
    () => ({
      transform: [
        {
          translateX: animationVisible
            ? (containerWidth + indicatorWidth) * travelProgress.value - indicatorWidth
            : 0,
        },
      ],
      width: indicatorWidth,
    }),
    [animationVisible, containerWidth, indicatorWidth],
  );

  return (
    <LoadingStripFrame onLayout={setContainerWidth}>
      <Animated.View className="h-full rounded-full bg-primary" style={indicatorStyle} />
    </LoadingStripFrame>
  );
}

export function LoadingStrip(props: { readonly progress?: number }) {
  if (props.progress === undefined) {
    return <IndeterminateLoadingStrip />;
  }

  const clampedProgress = Math.min(1, Math.max(0, props.progress));

  return (
    <LoadingStripFrame>
      <View
        className="h-full rounded-r-full bg-primary"
        style={{ width: `${clampedProgress * 100}%` }}
      />
    </LoadingStripFrame>
  );
}

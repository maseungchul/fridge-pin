/**
 * @file
 * 목록 선택 모드의 하단 도구바와 작업 버튼을 표시한다.
 * 안전 영역과 누름 색상을 공유하며, 실행과 입력 제한은 호출자가 관리한다.
 */
import type { ComponentProps, ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
import { FeedbackPressable } from '@/components/FeedbackPressable';
import { useAppTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/tokens';

export function SelectionToolbar({ children, background = 'surface', compact = false }: {
  children: ReactNode;
  background?: 'background' | 'surface';
  compact?: boolean;
}) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.toolbar, {
      height: 50 + insets.bottom, paddingBottom: insets.bottom,
      borderTopColor: colors.border, backgroundColor: colors[background],
    }, !compact && {
      paddingLeft: insets.left + spacing.sm + spacing.xs,
      paddingRight: insets.right + spacing.sm + spacing.xs,
      gap: spacing.xs * 2,
    }]}>
      {children}
    </View>
  );
}

export function SelectionToolbarButton({ icon, label, accessibilityLabel = label, disabled, interactionBlocked,
  destructive = false, onPress }: {
  icon: ComponentProps<typeof MaterialDesignIcons>['name'];
  label: string;
  accessibilityLabel?: string;
  disabled: boolean;
  interactionBlocked?: boolean;
  destructive?: boolean;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();
  const color = destructive ? colors.error : colors.text;
  const pressedColor = destructive ? colors.errorPressed : colors.iconPressed;

  return (
    <FeedbackPressable accessibilityRole="button" accessibilityLabel={accessibilityLabel}
      disabled={disabled} interactionBlocked={interactionBlocked} accessibilityState={{ disabled: disabled || !!interactionBlocked }}
      feedback="none" onPress={onPress} style={styles.button}>
      {({ pressed }) => {
        const foreground = pressed ? pressedColor : color;
        return <>
          <MaterialDesignIcons name={icon} size={24} color={foreground} accessible={false} pointerEvents="none" />
          <Text style={[styles.label, { color: foreground }]}>{label}</Text>
        </>;
      }}
    </FeedbackPressable>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: 'row', flexShrink: 0, borderTopWidth: StyleSheet.hairlineWidth },
  button: { flex: 1, minHeight: 48, paddingTop: spacing.xs, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 12, lineHeight: 16, textAlign: 'center', fontWeight: '600' },
});

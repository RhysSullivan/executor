/**
 * Barrel export of all UI components available to model-generated React code.
 * These are re-exports of the existing shadcn components from @executor/react,
 * plus Recharts primitives and Lucide icons.
 */

// ---------------------------------------------------------------------------
// shadcn/ui components
// ---------------------------------------------------------------------------

// Layout
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "../../../../react/src/components/card";
export { Separator } from "../../../../react/src/components/separator";
export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../../../react/src/components/tabs";
export {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../../../../react/src/components/accordion";
export {
  ScrollArea,
  ScrollBar,
} from "../../../../react/src/components/scroll-area";

// Overlay
export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "../../../../react/src/components/dialog";
export {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from "../../../../react/src/components/sheet";
export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
} from "../../../../react/src/components/popover";
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "../../../../react/src/components/tooltip";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "../../../../react/src/components/dropdown-menu";

// Input
export { Button } from "../../../../react/src/components/button";
export { Input } from "../../../../react/src/components/input";
export { Textarea } from "../../../../react/src/components/textarea";
export { Label } from "../../../../react/src/components/label";
export {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
} from "../../../../react/src/components/select";
export { Checkbox } from "../../../../react/src/components/checkbox";
export { RadioGroup, RadioGroupItem } from "../../../../react/src/components/radio-group";
export { Switch } from "../../../../react/src/components/switch";
export { Slider } from "../../../../react/src/components/slider";
export { Toggle } from "../../../../react/src/components/toggle";
export { ToggleGroup, ToggleGroupItem } from "../../../../react/src/components/toggle-group";

// Data display
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "../../../../react/src/components/table";
export { Badge } from "../../../../react/src/components/badge";
export {
  Avatar,
  AvatarImage,
  AvatarFallback,
} from "../../../../react/src/components/avatar";
export { Progress } from "../../../../react/src/components/progress";
export { Skeleton } from "../../../../react/src/components/skeleton";

// Feedback
export {
  Alert,
  AlertTitle,
  AlertDescription,
} from "../../../../react/src/components/alert";

// Charts (shadcn wrappers around Recharts)
export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
} from "../../../../react/src/components/chart";

// ---------------------------------------------------------------------------
// Recharts primitives (exposed directly for model use)
// ---------------------------------------------------------------------------

export {
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  RadialBarChart,
  RadialBar,
  ScatterChart,
  Scatter,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
  ReferenceArea,
  Brush,
  Funnel,
  FunnelChart,
  Treemap,
} from "recharts";

// ---------------------------------------------------------------------------
// Lucide icons (common subset)
// ---------------------------------------------------------------------------

export {
  Plus,
  Minus,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Search,
  Loader2,
  AlertCircle,
  AlertTriangle,
  Info,
  ExternalLink,
  Copy,
  Trash2,
  Edit,
  Settings,
  User,
  Users,
  Mail,
  Calendar,
  Clock,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Download,
  Upload,
  File,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Link,
  Globe,
  Home,
  Star,
  Heart,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  RefreshCw,
  RotateCcw,
  Filter,
  SortAsc,
  SortDesc,
  MoreHorizontal,
  MoreVertical,
  Menu,
  Grip,
  GripVertical,
  Code,
  Terminal,
  Database,
  Server,
  Cpu,
  Zap,
  Activity,
  TrendingUp,
  TrendingDown,
  BarChart3,
  PieChart as PieChartIcon,
  GitBranch,
  GitCommit,
  GitPullRequest,
  MessageSquare,
  Send,
  Bookmark,
  Tag,
  Hash,
  AtSign,
  Paperclip,
  MapPin,
  Phone,
  Video,
  Mic,
  Volume2,
  VolumeX,
  Play,
  Pause,
  Square,
  Circle,
  Triangle,
  Hexagon,
  Box,
  Package,
  Shield,
  Key,
  Wifi,
  WifiOff,
  Battery,
  Sun,
  Moon,
  CloudRain,
  Thermometer,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export { cn } from "../../../../react/src/lib/utils";
